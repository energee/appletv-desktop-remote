//! Native credential vault. The renderer can only address credentials by device identifier.
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, sync::Mutex};
use uuid::Uuid;

const SERVICE: &str = "com.tedslesinski.atv-desktop-remote";
const INDEX_ACCOUNT: &str = "device-index-v1";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedDevice {
    pub identifier: String,
    pub name: String,
    pub companion_paired: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct StoredCredential {
    identifier: String,
    name: String,
    credentials: String,
    #[serde(default)]
    companion_paired: bool,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Index {
    #[serde(default)]
    devices: Vec<SavedDevice>,
    #[serde(default)]
    active: Option<String>,
    /// Legacy device identifiers removed from metadata but awaiting a successful OS deletion.
    #[serde(default)]
    cleanup: Vec<String>,
    /// Credential accounts awaiting deletion after a committed replacement or failed staging.
    #[serde(default)]
    cleanup_accounts: Vec<String>,
    /// Versioned credential accounts. Missing entries use the legacy deterministic account.
    #[serde(default)]
    accounts: HashMap<String, String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct BackupPreferences {
    pub uimode: Option<String>,
    #[serde(rename = "alwaysOnTopChecked")]
    pub always_on_top_checked: Option<String>,
}

trait SecretStore: Send {
    fn read(&self, account: &str) -> Result<Option<String>, String>;
    fn write(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

struct OsSecretStore;

impl OsSecretStore {
    fn entry(account: &str) -> Result<Entry, String> {
        Entry::new(SERVICE, account).map_err(|error| error.to_string())
    }
}

impl SecretStore for OsSecretStore {
    fn read(&self, account: &str) -> Result<Option<String>, String> {
        match Self::entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn write(&self, account: &str, value: &str) -> Result<(), String> {
        Self::entry(account)?
            .set_password(value)
            .map_err(|error| error.to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

/// Serializes access because an index update follows each credential update.
pub struct Vault {
    store: Mutex<Box<dyn SecretStore>>,
    pending_pair: Mutex<Option<(Value, bool)>>,
}

impl Vault {
    pub fn native() -> Self {
        Self {
            store: Mutex::new(Box::new(OsSecretStore)),
            pending_pair: Mutex::new(None),
        }
    }

    fn device_account(identifier: &str) -> String {
        // Keychain/Credential Manager account names are strings. Hex prevents identifier syntax
        // from becoming part of the native credential namespace.
        let mut account = String::from("device-");
        for byte in identifier.bytes() {
            use std::fmt::Write;
            let _ = write!(account, "{byte:02x}");
        }
        account
    }

    fn account(index: &Index, identifier: &str) -> String {
        index
            .accounts
            .get(identifier)
            .cloned()
            .unwrap_or_else(|| Self::device_account(identifier))
    }

    fn staged_account() -> String {
        format!("device-{}", Uuid::new_v4())
    }

    fn index(store: &dyn SecretStore) -> Result<Index, String> {
        let Some(value) = store.read(INDEX_ACCOUNT)? else {
            return Ok(Index::default());
        };
        serde_json::from_str(&value).map_err(|_| "Saved device metadata is corrupted".to_owned())
    }

    fn save_index(store: &dyn SecretStore, index: &Index) -> Result<(), String> {
        let value = serde_json::to_string(index).map_err(|error| error.to_string())?;
        store.write(INDEX_ACCOUNT, &value)
    }

    fn finish_cleanup(store: &dyn SecretStore, index: &mut Index) -> Result<(), String> {
        if index.cleanup.is_empty() && index.cleanup_accounts.is_empty() {
            return Ok(());
        }

        let mut failed_identifiers = Vec::new();
        for identifier in std::mem::take(&mut index.cleanup) {
            if index
                .devices
                .iter()
                .any(|device| device.identifier == identifier)
            {
                continue;
            }
            if store.delete(&Self::device_account(&identifier)).is_err() {
                failed_identifiers.push(identifier);
            }
        }
        index.cleanup = failed_identifiers;

        let mut failed_accounts = Vec::new();
        for account in std::mem::take(&mut index.cleanup_accounts) {
            if index.accounts.values().any(|current| current == &account) {
                continue;
            }
            if store.delete(&account).is_err() {
                failed_accounts.push(account);
            }
        }
        index.cleanup_accounts = failed_accounts;
        Self::save_index(store, index)?;
        if index.cleanup.is_empty() && index.cleanup_accounts.is_empty() {
            Ok(())
        } else {
            Err("Could not remove old secure credentials; retry the operation".into())
        }
    }

    fn stage(
        store: &dyn SecretStore,
        index: &mut Index,
        pair: &StoredCredential,
    ) -> Result<String, String> {
        let account = Self::staged_account();
        index.cleanup_accounts.push(account.clone());
        Self::save_index(store, index)?;
        let encoded = serde_json::to_string(pair).map_err(|error| error.to_string())?;
        if let Err(error) = store.write(&account, &encoded) {
            let _ = Self::finish_cleanup(store, index);
            return Err(error);
        }
        Ok(account)
    }

    pub fn devices(&self) -> Result<Vec<SavedDevice>, String> {
        let store = self
            .store
            .lock()
            .map_err(|_| "Credential vault is unavailable")?;
        let mut index = Self::index(store.as_ref())?;
        let devices = index.devices.clone();
        let _ = Self::finish_cleanup(store.as_ref(), &mut index);
        Ok(devices)
    }

    pub fn active(&self) -> Result<Option<String>, String> {
        let store = self
            .store
            .lock()
            .map_err(|_| "Credential vault is unavailable")?;
        let mut index = Self::index(store.as_ref())?;
        let active = index.active.clone();
        let _ = Self::finish_cleanup(store.as_ref(), &mut index);
        Ok(active)
    }

    pub fn select(&self, identifier: Option<String>) -> Result<(), String> {
        let store = self
            .store
            .lock()
            .map_err(|_| "Credential vault is unavailable")?;
        let mut index = Self::index(store.as_ref())?;
        if let Some(identifier) = identifier.as_ref() {
            if !index
                .devices
                .iter()
                .any(|device| device.identifier == *identifier)
            {
                return Err("Unknown saved Apple TV".into());
            }
        }
        index.active = identifier;
        Self::save_index(store.as_ref(), &index)
    }

    pub fn remove(&self, identifier: &str) -> Result<(), String> {
        let store = self
            .store
            .lock()
            .map_err(|_| "Credential vault is unavailable")?;
        let mut index = Self::index(store.as_ref())?;
        let account = Self::account(&index, identifier);
        index
            .devices
            .retain(|device| device.identifier != identifier);
        index.accounts.remove(identifier);
        if index.active.as_deref() == Some(identifier) {
            index.active = None;
        }
        if !index.cleanup_accounts.contains(&account) {
            index.cleanup_accounts.push(account);
        }
        // Metadata commits before deletion, so an index write failure cannot lose the secret.
        Self::save_index(store.as_ref(), &index)?;
        let _ = Self::finish_cleanup(store.as_ref(), &mut index);
        Ok(())
    }

    fn save_pair(&self, pair: StoredCredential) -> Result<SavedDevice, String> {
        validate_credential(&pair)?;
        let saved = SavedDevice {
            identifier: pair.identifier.clone(),
            name: pair.name.clone(),
            companion_paired: pair.companion_paired,
        };
        let store = self
            .store
            .lock()
            .map_err(|_| "Credential vault is unavailable")?;
        let mut index = Self::index(store.as_ref())?;
        let account = Self::stage(store.as_ref(), &mut index, &pair)?;
        let mut staged_index = index.clone();
        let old_account = index
            .devices
            .iter()
            .any(|device| device.identifier == saved.identifier)
            .then(|| Self::account(&index, &saved.identifier));
        if let Some(existing) = index
            .devices
            .iter_mut()
            .find(|device| device.identifier == saved.identifier)
        {
            *existing = saved.clone();
        } else {
            index.devices.push(saved.clone());
        }
        index
            .accounts
            .insert(saved.identifier.clone(), account.clone());
        index.cleanup_accounts.retain(|pending| pending != &account);
        if let Some(old_account) = old_account {
            index.cleanup_accounts.push(old_account);
        }
        if let Err(error) = Self::save_index(store.as_ref(), &index) {
            let _ = Self::finish_cleanup(store.as_ref(), &mut staged_index);
            return Err(error);
        }
        let _ = Self::finish_cleanup(store.as_ref(), &mut index);
        Ok(saved)
    }

    fn credentials(&self, identifier: &str) -> Result<StoredCredential, String> {
        let store = self
            .store
            .lock()
            .map_err(|_| "Credential vault is unavailable")?;
        let index = Self::index(store.as_ref())?;
        let encoded = store
            .read(&Self::account(&index, identifier))?
            .ok_or("No credentials for saved Apple TV")?;
        let credential: StoredCredential = serde_json::from_str(&encoded)
            .map_err(|_| "Saved credentials are corrupted".to_owned())?;
        validate_credential(&credential)?;
        if credential.identifier != identifier {
            return Err("Saved credential identifier mismatch".into());
        }
        Ok(credential)
    }

    pub fn save_sidecar_pair(
        &self,
        value: Value,
        companion_paired: bool,
    ) -> Result<SavedDevice, String> {
        let mut pair: StoredCredential = serde_json::from_value(value.clone())
            .map_err(|_| "Apple TV pairing returned invalid credentials")?;
        pair.companion_paired = companion_paired;
        match self.save_pair(pair) {
            Ok(saved) => Ok(saved),
            Err(error) => {
                *self
                    .pending_pair
                    .lock()
                    .map_err(|_| "Secure storage: credential vault is unavailable")? =
                    Some((value, companion_paired));
                Err(format!("Secure storage: {error}"))
            }
        }
    }

    /// Retries saving a completed pairing without asking the Apple TV for another PIN.
    pub fn retry_pending_pair(
        &self,
        companion_paired: bool,
    ) -> Result<Option<SavedDevice>, String> {
        let pending = self
            .pending_pair
            .lock()
            .map_err(|_| "Secure storage: credential vault is unavailable")?
            .clone();
        let Some((value, pending_companion)) = pending else {
            return Ok(None);
        };
        if pending_companion != companion_paired {
            return Ok(None);
        }
        let saved = self.save_sidecar_pair(value, companion_paired)?;
        *self
            .pending_pair
            .lock()
            .map_err(|_| "Secure storage: credential vault is unavailable")? = None;
        Ok(Some(saved))
    }

    /// A new pairing/connect lifecycle invalidates an unsaved completed pairing.
    pub fn clear_pending_pair(&self) -> Result<(), String> {
        *self
            .pending_pair
            .lock()
            .map_err(|_| "Credential vault is unavailable")? = None;
        Ok(())
    }

    pub fn connection_params(&self, identifier: &str) -> Result<Value, String> {
        let pair = self.credentials(identifier)?;
        Ok(serde_json::json!({"identifier": pair.identifier, "credentials": pair.credentials}))
    }

    /// Migrates legacy renderer storage without replacing credentials referenced by the current
    /// index until every imported secret is safely staged.
    pub fn migrate(&self, devices: Option<String>, active: Option<String>) -> Result<(), String> {
        let mut pairs = legacy_devices(devices.as_deref())?;
        let active_pair = legacy_active_pair(active.as_deref())?;
        let active = legacy_active(active.as_deref())?;
        if let Some(pair) = active_pair {
            if !pairs
                .iter()
                .any(|saved| saved.identifier == pair.identifier)
            {
                pairs.push(pair);
            }
        }
        for pair in &pairs {
            validate_credential(pair)?;
        }
        let store = self
            .store
            .lock()
            .map_err(|_| "Credential vault is unavailable")?;
        let mut index = Self::index(store.as_ref())?;
        let mut staged = Vec::with_capacity(pairs.len());
        for pair in pairs {
            let account = Self::stage(store.as_ref(), &mut index, &pair)?;
            staged.push((pair, account));
        }
        let mut staged_index = index.clone();
        for (pair, account) in staged {
            let saved = SavedDevice {
                identifier: pair.identifier.clone(),
                name: pair.name,
                companion_paired: pair.companion_paired,
            };
            let old_account = index
                .devices
                .iter()
                .any(|device| device.identifier == saved.identifier)
                .then(|| Self::account(&index, &saved.identifier));
            if let Some(existing) = index
                .devices
                .iter_mut()
                .find(|device| device.identifier == saved.identifier)
            {
                *existing = saved.clone();
            } else {
                index.devices.push(saved.clone());
            }
            index.accounts.insert(saved.identifier, account.clone());
            index.cleanup_accounts.retain(|pending| pending != &account);
            if let Some(old_account) = old_account {
                index.cleanup_accounts.push(old_account);
            }
        }
        if let Some(active) = active {
            if index.devices.iter().any(|item| item.identifier == active) {
                index.active = Some(active);
            }
        }
        if let Err(error) = Self::save_index(store.as_ref(), &index) {
            let _ = Self::finish_cleanup(store.as_ref(), &mut staged_index);
            return Err(error);
        }
        let _ = Self::finish_cleanup(store.as_ref(), &mut index);
        Ok(())
    }

    /// JSON passed only to native desktop backup file code; never exposed through IPC.
    pub fn export_backup(&self, preferences: BackupPreferences) -> Result<String, String> {
        let store = self
            .store
            .lock()
            .map_err(|_| "Credential vault is unavailable")?;
        let index = Self::index(store.as_ref())?;
        let mut devices = Vec::with_capacity(index.devices.len());
        for device in &index.devices {
            let encoded = store
                .read(&Self::account(&index, &device.identifier))?
                .ok_or("A saved Apple TV credential is missing")?;
            devices.push(
                serde_json::from_str::<StoredCredential>(&encoded)
                    .map_err(|_| "Saved credentials are corrupted")?,
            );
        }
        serde_json::to_string(&serde_json::json!({
            "version": 1, "devices": devices, "active": index.active, "preferences": preferences,
        }))
        .map_err(|error| error.to_string())
    }

    /// Validates every backup entry before any OS credential write occurs and replaces the
    /// saved-device set (including an empty backup and null active selection).
    pub fn import_backup(&self, contents: &str) -> Result<BackupPreferences, String> {
        let value: Value =
            serde_json::from_str(contents).map_err(|_| "Backup is not valid JSON")?;
        if !value.is_object()
            || (value.get("devices").is_none()
                && value.get("remote_credentials").is_none()
                && value.get("atvcreds").is_none())
        {
            return Err("Not an Apple TV Remote credential backup".into());
        }
        if value
            .get("version")
            .is_some_and(|version| version.as_u64() != Some(1))
        {
            return Err("Unsupported credential backup version".into());
        }
        for name in ["remote_credentials", "atvcreds"] {
            if value
                .get(name)
                .is_some_and(|field| !field.is_null() && !field.is_string())
            {
                return Err("Backup credentials must be encoded strings or null".into());
            }
        }
        let mut pairs = if value.get("devices").is_some() {
            backup_devices(&value)?
        } else {
            legacy_devices(value.get("remote_credentials").and_then(Value::as_str))?
        };
        let legacy_active_bytes = value.get("atvcreds").and_then(Value::as_str);
        if let Some(pair) = legacy_active_pair(legacy_active_bytes)? {
            if !pairs
                .iter()
                .any(|saved| saved.identifier == pair.identifier)
            {
                pairs.push(pair);
            }
        }
        for pair in &pairs {
            validate_credential(pair)?;
        }
        let active = value
            .get("active")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or(legacy_active(legacy_active_bytes)?);
        if let Some(active) = active.as_ref() {
            if !pairs.iter().any(|pair| &pair.identifier == active) {
                return Err("Backup selects an unknown Apple TV".into());
            }
        }
        let preferences = if let Some(preferences) = value.get("preferences") {
            serde_json::from_value(preferences.clone())
                .map_err(|_| "Backup preferences are invalid")?
        } else {
            BackupPreferences {
                uimode: value
                    .get("uimode")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                always_on_top_checked: value
                    .get("alwaysOnTopChecked")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            }
        };

        let store = self
            .store
            .lock()
            .map_err(|_| "Credential vault is unavailable")?;
        let old_index = Self::index(store.as_ref())?;
        let mut index = old_index.clone();
        let mut staged = Vec::with_capacity(pairs.len());
        for pair in pairs {
            let account = Self::stage(store.as_ref(), &mut index, &pair)?;
            staged.push((pair, account));
        }
        let mut staged_index = index.clone();
        let mut devices = Vec::with_capacity(staged.len());
        let mut accounts = HashMap::with_capacity(staged.len());
        for (pair, account) in staged {
            devices.push(SavedDevice {
                identifier: pair.identifier.clone(),
                name: pair.name,
                companion_paired: pair.companion_paired,
            });
            accounts.insert(pair.identifier, account);
        }
        index.active = active;
        index.devices = devices;
        index.accounts = accounts;
        let accounts = &index.accounts;
        index
            .cleanup_accounts
            .retain(|account| !accounts.values().any(|current| current == account));
        for old in &old_index.devices {
            let account = Self::account(&old_index, &old.identifier);
            if !index.cleanup_accounts.contains(&account) {
                index.cleanup_accounts.push(account);
            }
        }
        if let Err(error) = Self::save_index(store.as_ref(), &index) {
            let _ = Self::finish_cleanup(store.as_ref(), &mut staged_index);
            return Err(error);
        }
        // Cleanup is deferred and nonfatal: the durable index is the logical commit point.
        let _ = Self::finish_cleanup(store.as_ref(), &mut index);
        Ok(preferences)
    }
}

fn validate_credential(pair: &StoredCredential) -> Result<(), String> {
    if pair.identifier.trim().is_empty()
        || pair.name.trim().is_empty()
        || pair.credentials.is_empty()
    {
        Err("Invalid saved Apple TV credentials".into())
    } else {
        Ok(())
    }
}

fn unwrap_json(mut value: Value) -> Value {
    while let Value::String(encoded) = &value {
        match serde_json::from_str(encoded) {
            Ok(next) => value = next,
            Err(_) => break,
        }
    }
    value
}

fn legacy_devices(raw: Option<&str>) -> Result<Vec<StoredCredential>, String> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let Value::Object(entries) =
        unwrap_json(serde_json::from_str(raw).map_err(|_| "Legacy saved devices are invalid")?)
    else {
        return Err("Legacy saved devices are invalid".into());
    };
    let mut pairs = Vec::new();
    for (key, raw_pair) in entries {
        let Value::Object(pair) = unwrap_json(raw_pair) else {
            continue;
        };
        let identifier = pair
            .get("identifier")
            .and_then(Value::as_str)
            .unwrap_or(&key)
            .to_owned();
        let name = pair
            .get("name")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| {
                key.rsplit_once(" (")
                    .map_or(key.clone(), |(name, _)| name.to_owned())
            });
        let Some(credentials) = pair.get("credentials").and_then(Value::as_str) else {
            continue;
        };
        pairs.push(StoredCredential {
            identifier,
            name,
            credentials: credentials.to_owned(),
            companion_paired: pair
                .get("companionPaired")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
    }
    Ok(pairs)
}

fn legacy_active(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = raw else { return Ok(None) };
    let Value::Object(active) =
        unwrap_json(serde_json::from_str(raw).map_err(|_| "Legacy active device is invalid")?)
    else {
        return Ok(None);
    };
    Ok(active
        .get("identifier")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned))
}

fn legacy_active_pair(raw: Option<&str>) -> Result<Option<StoredCredential>, String> {
    let Some(raw) = raw else { return Ok(None) };
    let Value::Object(active) =
        unwrap_json(serde_json::from_str(raw).map_err(|_| "Legacy active device is invalid")?)
    else {
        return Ok(None);
    };
    let Some(identifier) = active.get("identifier").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some(credentials) = active.get("credentials").and_then(Value::as_str) else {
        return Ok(None);
    };
    Ok(Some(StoredCredential {
        identifier: identifier.to_owned(),
        name: active
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(identifier)
            .to_owned(),
        credentials: credentials.to_owned(),
        companion_paired: active
            .get("companionPaired")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }))
}

fn backup_devices(value: &Value) -> Result<Vec<StoredCredential>, String> {
    let devices = value
        .get("devices")
        .and_then(Value::as_array)
        .ok_or("Backup has no devices")?;
    devices
        .iter()
        .cloned()
        .map(|value| {
            serde_json::from_value(value).map_err(|_| "Backup contains invalid credentials".into())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct TestStore(Mutex<HashMap<String, String>>);
    impl SecretStore for TestStore {
        fn read(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(account).cloned())
        }
        fn write(&self, account: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(account.into(), value.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(account);
            Ok(())
        }
    }
    fn vault() -> Vault {
        Vault {
            store: Mutex::new(Box::new(TestStore::default())),
            pending_pair: Mutex::new(None),
        }
    }

    struct FailingStore;
    impl SecretStore for FailingStore {
        fn read(&self, _: &str) -> Result<Option<String>, String> {
            Ok(None)
        }
        fn write(&self, _: &str, _: &str) -> Result<(), String> {
            Err("access denied".into())
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
    }

    struct IndexFailStore(Mutex<HashMap<String, String>>);
    impl SecretStore for IndexFailStore {
        fn read(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(account).cloned())
        }
        fn write(&self, account: &str, value: &str) -> Result<(), String> {
            if account == INDEX_ACCOUNT {
                Err("index denied".into())
            } else {
                self.0.lock().unwrap().insert(account.into(), value.into());
                Ok(())
            }
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(account);
            Ok(())
        }
    }

    struct ScriptedStore {
        records: Mutex<HashMap<String, String>>,
        secret_failure: Mutex<Option<usize>>,
        index_failure: Mutex<Option<usize>>,
        fail_deletes: bool,
    }

    impl SecretStore for ScriptedStore {
        fn read(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.records.lock().unwrap().get(account).cloned())
        }

        fn write(&self, account: &str, value: &str) -> Result<(), String> {
            let failure = if account == INDEX_ACCOUNT {
                &self.index_failure
            } else {
                &self.secret_failure
            };
            let mut remaining = failure.lock().unwrap();
            if remaining.is_some_and(|count| count == 1) {
                *remaining = None;
                return Err("injected write failure".into());
            }
            if let Some(count) = remaining.as_mut() {
                *count -= 1;
            }
            self.records
                .lock()
                .unwrap()
                .insert(account.into(), value.into());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), String> {
            if self.fail_deletes {
                Err("injected delete failure".into())
            } else {
                self.records.lock().unwrap().remove(account);
                Ok(())
            }
        }
    }

    fn scripted_vault(
        secret_failure: Option<usize>,
        index_failure: Option<usize>,
        fail_deletes: bool,
    ) -> Vault {
        let pair = StoredCredential {
            identifier: "old".into(),
            name: "Old".into(),
            credentials: "working-secret".into(),
            companion_paired: false,
        };
        let mut records = HashMap::new();
        records.insert(
            Vault::device_account("old"),
            serde_json::to_string(&pair).unwrap(),
        );
        records.insert(
            INDEX_ACCOUNT.into(),
            serde_json::to_string(&Index {
                devices: vec![SavedDevice {
                    identifier: "old".into(),
                    name: "Old".into(),
                    companion_paired: false,
                }],
                active: Some("old".into()),
                cleanup: Vec::new(),
                cleanup_accounts: Vec::new(),
                accounts: HashMap::new(),
            })
            .unwrap(),
        );
        Vault {
            store: Mutex::new(Box::new(ScriptedStore {
                records: Mutex::new(records),
                secret_failure: Mutex::new(secret_failure),
                index_failure: Mutex::new(index_failure),
                fail_deletes,
            })),
            pending_pair: Mutex::new(None),
        }
    }

    #[test]
    fn migration_keeps_secrets_out_of_metadata_and_preserves_active() {
        let vault = vault();
        vault.migrate(
            Some(r#"{"Living room (1.2.3.4)":"{\"identifier\":\"id\",\"name\":\"Living room\",\"credentials\":\"secret\"}"}"#.into()),
            Some(r#"{"identifier":"id","credentials":"secret"}"#.into()),
        ).unwrap();
        assert_eq!(
            vault.devices().unwrap(),
            vec![SavedDevice {
                identifier: "id".into(),
                name: "Living room".into(),
                companion_paired: false
            }]
        );
        assert_eq!(vault.active().unwrap().as_deref(), Some("id"));
        assert_eq!(vault.credentials("id").unwrap().credentials, "secret");
    }

    #[test]
    fn remove_deletes_secret_and_selection() {
        let vault = vault();
        vault
            .save_pair(StoredCredential {
                identifier: "id".into(),
                name: "TV".into(),
                credentials: "secret".into(),
                companion_paired: false,
            })
            .unwrap();
        vault.select(Some("id".into())).unwrap();
        vault.remove("id").unwrap();
        assert!(vault.credentials("id").is_err());
        assert_eq!(vault.active().unwrap(), None);
    }

    #[test]
    fn invalid_backup_cannot_replace_working_pairings() {
        let vault = vault();
        vault
            .save_pair(StoredCredential {
                identifier: "id".into(),
                name: "TV".into(),
                credentials: "secret".into(),
                companion_paired: false,
            })
            .unwrap();
        vault.select(Some("id".into())).unwrap();
        for invalid in [
            r#"{}"#,
            r#"{"remote_credentials":123}"#,
            r#"{"version":2,"devices":[]}"#,
        ] {
            assert!(vault.import_backup(invalid).is_err());
            assert_eq!(vault.active().unwrap().as_deref(), Some("id"));
            assert_eq!(vault.credentials("id").unwrap().credentials, "secret");
        }
    }

    #[test]
    fn restored_pairing_is_not_deleted_by_an_old_cleanup_record() {
        let vault = vault();
        vault
            .save_pair(StoredCredential {
                identifier: "id".into(),
                name: "TV".into(),
                credentials: "secret".into(),
                companion_paired: false,
            })
            .unwrap();
        {
            let store = vault.store.lock().unwrap();
            let mut index = Vault::index(store.as_ref()).unwrap();
            index.cleanup.push("id".into());
            Vault::save_index(store.as_ref(), &index).unwrap();
        }
        let backup = vault.export_backup(BackupPreferences::default()).unwrap();
        vault.import_backup(&backup).unwrap();
        assert_eq!(vault.credentials("id").unwrap().credentials, "secret");
        assert_eq!(vault.devices().unwrap().len(), 1);
    }

    #[test]
    fn failed_remove_index_commit_leaves_credential_available() {
        let pair = StoredCredential {
            identifier: "id".into(),
            name: "TV".into(),
            credentials: "secret".into(),
            companion_paired: false,
        };
        let mut records = HashMap::new();
        records.insert(
            INDEX_ACCOUNT.into(),
            serde_json::to_string(&Index {
                devices: vec![SavedDevice {
                    identifier: "id".into(),
                    name: "TV".into(),
                    companion_paired: false,
                }],
                active: Some("id".into()),
                cleanup: Vec::new(),
                cleanup_accounts: Vec::new(),
                accounts: HashMap::new(),
            })
            .unwrap(),
        );
        records.insert(
            Vault::device_account("id"),
            serde_json::to_string(&pair).unwrap(),
        );
        let vault = Vault {
            store: Mutex::new(Box::new(IndexFailStore(Mutex::new(records)))),
            pending_pair: Mutex::new(None),
        };
        assert!(vault.remove("id").is_err());
        assert_eq!(vault.credentials("id").unwrap().credentials, "secret");
    }

    #[test]
    fn import_replaces_devices_and_allows_an_empty_backup_to_clear_selection() {
        let vault = vault();
        vault
            .save_pair(StoredCredential {
                identifier: "old".into(),
                name: "Old".into(),
                credentials: "old-secret".into(),
                companion_paired: false,
            })
            .unwrap();
        vault.select(Some("old".into())).unwrap();
        vault.import_backup(r#"{"version":1,"devices":[{"identifier":"new","name":"New","credentials":"new-secret"}],"active":null}"#).unwrap();
        assert_eq!(
            vault.devices().unwrap(),
            vec![SavedDevice {
                identifier: "new".into(),
                name: "New".into(),
                companion_paired: false
            }]
        );
        assert_eq!(vault.active().unwrap(), None);
        assert!(vault.credentials("old").is_err());
        vault
            .import_backup(r#"{"version":1,"devices":[],"active":null}"#)
            .unwrap();
        assert!(vault.devices().unwrap().is_empty());
    }

    #[test]
    fn storage_failure_retains_completed_pair_for_a_native_retry() {
        let vault = Vault {
            store: Mutex::new(Box::new(FailingStore)),
            pending_pair: Mutex::new(None),
        };
        let error = vault
            .save_sidecar_pair(
                serde_json::json!({"identifier":"id","name":"TV","credentials":"secret"}),
                false,
            )
            .unwrap_err();
        assert!(error.starts_with("Secure storage:"));
        assert!(vault.pending_pair.lock().unwrap().is_some());
    }

    #[test]
    fn new_pairing_lifecycle_clears_pending_credentials() {
        let vault = vault();
        *vault.pending_pair.lock().unwrap() = Some((
            serde_json::json!({"identifier":"old","name":"Old TV","credentials":"secret"}),
            false,
        ));
        assert_eq!(vault.retry_pending_pair(true).unwrap(), None);
        vault.clear_pending_pair().unwrap();
        assert!(vault.pending_pair.lock().unwrap().is_none());
    }

    #[test]
    fn failed_import_secret_stage_preserves_existing_pairing() {
        let vault = scripted_vault(Some(2), None, false);

        assert!(vault
            .import_backup(
                r#"{"version":1,"devices":[{"identifier":"old","name":"Replaced","credentials":"obsolete"},{"identifier":"new","name":"New","credentials":"new"}],"active":"new"}"#,
            )
            .is_err());

        assert_eq!(vault.active().unwrap().as_deref(), Some("old"));
        assert_eq!(vault.devices().unwrap()[0].name, "Old");
        assert_eq!(
            vault.credentials("old").unwrap().credentials,
            "working-secret"
        );
    }

    #[test]
    fn failed_pair_commit_preserves_existing_credentials() {
        let vault = scripted_vault(None, Some(2), false);

        assert!(vault
            .save_pair(StoredCredential {
                identifier: "old".into(),
                name: "Replaced".into(),
                credentials: "obsolete".into(),
                companion_paired: false,
            })
            .is_err());

        assert_eq!(
            vault.credentials("old").unwrap().credentials,
            "working-secret"
        );
    }

    #[test]
    fn failed_migration_commit_preserves_existing_credentials() {
        let vault = scripted_vault(None, Some(2), false);

        assert!(vault
            .migrate(
                Some(
                    r#"{"old":{"identifier":"old","name":"Replaced","credentials":"obsolete"}}"#
                        .into(),
                ),
                None,
            )
            .is_err());

        assert_eq!(
            vault.credentials("old").unwrap().credentials,
            "working-secret"
        );
    }

    #[test]
    fn failed_import_index_commit_preserves_existing_pairing() {
        let vault = scripted_vault(None, Some(3), false);

        assert!(vault
            .import_backup(
                r#"{"version":1,"devices":[{"identifier":"old","name":"Replaced","credentials":"obsolete"},{"identifier":"new","name":"New","credentials":"new"}],"active":"new"}"#,
            )
            .is_err());

        assert_eq!(vault.active().unwrap().as_deref(), Some("old"));
        assert_eq!(vault.devices().unwrap()[0].name, "Old");
        assert_eq!(
            vault.credentials("old").unwrap().credentials,
            "working-secret"
        );
    }

    #[test]
    fn cleanup_failure_after_import_is_nonfatal_and_durable() {
        let vault = scripted_vault(None, None, true);

        vault
            .import_backup(
                r#"{"version":1,"devices":[{"identifier":"new","name":"New","credentials":"new"}],"active":"new"}"#,
            )
            .unwrap();

        assert_eq!(vault.active().unwrap().as_deref(), Some("new"));
        assert_eq!(vault.credentials("new").unwrap().credentials, "new");
        let store = vault.store.lock().unwrap();
        assert!(!Vault::index(store.as_ref())
            .unwrap()
            .cleanup_accounts
            .is_empty());
    }
}

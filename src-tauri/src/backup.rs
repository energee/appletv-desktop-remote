use std::{fs::File, io, io::Write, path::Path};

use tempfile::NamedTempFile;

/// Atomically replaces a secret backup after its complete private replacement is durable.
pub fn write_private(path: &Path, contents: &str) -> io::Result<()> {
    write_private_with(path, contents.as_bytes(), |file, contents| {
        file.write_all(contents)
    })
}

fn write_private_with(
    path: &Path,
    contents: &[u8],
    write: impl FnOnce(&mut File, &[u8]) -> io::Result<()>,
) -> io::Result<()> {
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    let mut replacement = NamedTempFile::new_in(directory)?;
    set_private_permissions(replacement.as_file())?;
    write(replacement.as_file_mut(), contents)?;
    replacement.as_file().sync_all()?;
    replacement.persist(path).map_err(|error| error.error)?;
    Ok(())
}

#[cfg(unix)]
fn set_private_permissions(file: &File) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    file.set_permissions(std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_permissions(_: &File) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_replacement_preserves_existing_backup() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("credentials.json");
        std::fs::write(&path, "recoverable backup").unwrap();

        assert!(write_private_with(&path, b"replacement", |file, contents| {
            file.write_all(&contents[..4])?;
            Err(io::Error::other("interrupted write"))
        })
        .is_err());

        assert_eq!(std::fs::read_to_string(path).unwrap(), "recoverable backup");
    }

    #[test]
    fn replacement_is_complete_and_private() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("credentials.json");
        std::fs::write(&path, "old").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        write_private(&path, "complete backup").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "complete backup");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}

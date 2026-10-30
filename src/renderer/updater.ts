import { desktopAPI } from '../shared/desktop-api';
import type { UpdateState } from '../shared/update';

/** The native host owns the download and all security decisions; this view can be dismissed. */
export function initUpdater(): void {
  const dialog = document.getElementById('updateDialog') as HTMLDialogElement;
  const pill = document.getElementById('updatePill') as HTMLButtonElement;
  const primary = document.getElementById('updatePrimary') as HTMLButtonElement;
  const later = document.getElementById('updateLater') as HTMLButtonElement;
  const autoCheck = document.getElementById('settingsAutoUpdate') as HTMLInputElement;
  const settingsButton = document.getElementById('settingsUpdateBtn') as HTMLButtonElement;
  const progress = document.getElementById('updateProgress') as HTMLProgressElement;
  let state: UpdateState | undefined;
  let localError: string | null = null;
  let commandPending = false;
  let preferencePending = false;

  function text(id: string, value: string): void {
    document.getElementById(id)!.textContent = value;
  }

  function visible(id: string, show: boolean): void {
    document.getElementById(id)!.hidden = !show;
  }

  function render(): void {
    const status = localError ? 'error' : (state?.status ?? 'idle');
    const version = state?.version;
    const current = state?.currentVersion;
    const error = localError ?? state?.error;
    const busy = status === 'checking' || status === 'downloading' || status === 'installing';
    pill.hidden =
      !version || !['available', 'downloading', 'ready', 'installing', 'error'].includes(status);
    let pillLabel = 'Update available';
    if (status === 'downloading') pillLabel = 'Downloading update';
    if (status === 'ready') pillLabel = 'Update ready';
    if (status === 'installing') pillLabel = 'Installing update';
    if (status === 'error') pillLabel = 'Update needs attention';
    text('updatePillLabel', pillLabel);
    text('settingsAppVersion', current ? `Version ${current}` : 'Apple TV Remote');
    autoCheck.checked = state?.autoCheck ?? true;
    autoCheck.disabled = !state || preferencePending;
    primary.disabled = busy || commandPending;
    later.disabled = status === 'installing';
    text('updateLater', status === 'downloading' ? 'Keep using remote' : 'Later');
    if (status === 'upToDate' || status === 'idle' || status === 'error')
      text('updateLater', 'Done');

    let title = 'Software update';
    let description = 'Check for a newer version of Apple TV Remote.';
    let action = 'Check for updates';
    let footnote = 'Updates are verified before installation.';
    switch (status) {
      case 'checking':
        title = 'Checking for updates…';
        description = 'Checking for the latest version of Apple TV Remote.';
        action = 'Checking…';
        break;
      case 'upToDate':
        title = 'You’re up to date';
        description = 'You’re running the latest version.';
        action = 'Check again';
        break;
      case 'available':
        title = 'Update available';
        description = 'A new version of Apple TV Remote is available.';
        action = 'Download update';
        footnote = 'Installation requires a restart.';
        break;
      case 'downloading':
        title = 'Downloading update';
        description = 'You can continue using the remote.';
        action = 'Downloading…';
        footnote = 'The download will be verified before installation.';
        break;
      case 'ready':
        title = 'Ready to install';
        description = 'The update is downloaded and verified.';
        action = 'Install & restart';
        footnote = 'Your saved devices and settings will be kept.';
        break;
      case 'installing':
        title = 'Installing update';
        description = 'Apple TV Remote will restart automatically.';
        action = 'Installing…';
        footnote = 'Your saved devices and settings will be kept.';
        break;
      case 'error':
        title = 'Update failed';
        description = 'The update could not be completed.';
        action = 'Try again';
        footnote = 'You can continue using the current version.';
        break;
    }
    text('updateTitle', title);
    text('updateDescription', description);
    text('updatePrimary', action);
    text('updateFootnote', footnote);
    text(
      'updateVersion',
      version && current ? `${current} → ${version}` : `Version ${current ?? '—'}`,
    );
    visible('updateVersion', Boolean(current));
    const showNotes = Boolean(state?.notes) && ['available', 'ready'].includes(status);
    visible('updateNotesSection', showNotes);
    // Release content is untrusted; never render it as HTML or execute embedded links.
    text('updateNotes', state?.notes ?? '');
    text('updateError', error ?? '');
    visible('updateError', Boolean(error));
    visible('updateProgressSection', busy);
    const total = state?.total;
    if (status === 'downloading' && state && total && total > 0) {
      const percent = Math.min(100, Math.max(0, (state.downloaded / total) * 100));
      progress.value = percent;
      const downloaded = (state.downloaded / 1048576).toFixed(1);
      const size = (total / 1048576).toFixed(1);
      text(
        'updateProgressLabel',
        percent >= 100
          ? 'Verifying signature…'
          : `${downloaded} of ${size} MB · ${Math.floor(percent)}%`,
      );
    } else {
      progress.removeAttribute('value');
      let label = 'Connecting securely…';
      if (status === 'installing') label = 'Installing and restarting…';
      if (status === 'downloading')
        label = `${((state?.downloaded ?? 0) / 1048576).toFixed(1)} MB downloaded`;
      text('updateProgressLabel', label);
    }
  }

  function accept(next: UpdateState): void {
    if (state && next.revision < state.revision) return;
    state = next;
    localError = null;
    render();
  }

  async function run(command: () => Promise<void>): Promise<void> {
    if (commandPending) return;
    commandPending = true;
    localError = null;
    render();
    try {
      await command();
    } catch (error) {
      localError = error instanceof Error ? error.message : String(error);
    } finally {
      commandPending = false;
      render();
    }
  }

  async function open(check: boolean): Promise<void> {
    if (!dialog.open) dialog.showModal();
    render();
    try {
      accept(await desktopAPI.updateStatus());
      if (check && state && ['idle', 'upToDate', 'error'].includes(state.status)) {
        await run(desktopAPI.updateCheck);
      }
    } catch (error) {
      localError = error instanceof Error ? error.message : String(error);
      render();
    }
    // A disabled primary button cannot receive focus during a background operation.
    if (dialog.open) (primary.disabled ? later : primary).focus();
  }

  primary.addEventListener('click', () => {
    if (!state) {
      void open(true);
      return;
    }
    if (!localError && state.status === 'available') void run(desktopAPI.updateDownload);
    else if (!localError && state.status === 'ready') void run(desktopAPI.updateInstall);
    else void run(desktopAPI.updateCheck);
  });
  later.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', (event) => {
    if (state?.status === 'installing') event.preventDefault();
  });
  // Disabling a focused button can move focus to body; guard there too, not just in the dialog.
  window.addEventListener(
    'keydown',
    (event) => {
      if (!dialog.open) return;
      event.stopImmediatePropagation();
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'),
      ).filter((element) => element.getClientRects().length > 0);
      const index = controls.indexOf(document.activeElement as HTMLElement);
      const next = index + (event.shiftKey ? -1 : 1);
      if (index < 0 || next < 0 || next >= controls.length) {
        event.preventDefault();
        controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
      }
    },
    true,
  );
  dialog.addEventListener('contextmenu', (event) => event.stopPropagation());
  pill.addEventListener('click', () => void open(false));
  settingsButton.addEventListener('click', () => void open(true));
  for (const control of [pill, settingsButton, autoCheck]) {
    control.addEventListener('keydown', (event) => event.stopPropagation());
  }
  autoCheck.addEventListener('change', () => {
    const value = autoCheck.checked;
    preferencePending = true;
    autoCheck.disabled = true;
    void desktopAPI
      .updateAutoCheck(value)
      .then(accept)
      .catch((error: unknown) => {
        localError = error instanceof Error ? error.message : String(error);
        if (!dialog.open) dialog.showModal();
      })
      .finally(() => {
        preferencePending = false;
        render();
      });
  });
  desktopAPI.onUpdateState(accept);
  desktopAPI.onContextMenuAction((action) => {
    if (action === 'openUpdates') void open(true);
  });
  render();
  void desktopAPI
    .updateStatus()
    .then(accept)
    .catch((error: unknown) => {
      // Startup failures must never cover the remote; a manual check exposes the error.
      console.error('Unable to read update status:', error);
    });
}

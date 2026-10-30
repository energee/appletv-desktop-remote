import { getVersion } from '@tauri-apps/api/app';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { desktopAPI } from '../shared/desktop-api';

type Status =
  | 'idle'
  | 'checking'
  | 'upToDate'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';
type FailedOperation = 'check' | 'download' | 'install' | 'restart';
type Copy = readonly [title: string, action: string, description: string];

const AUTO_CHECK_KEY = 'autoUpdateChecks';
const DAY = 24 * 60 * 60 * 1000;
const COPY: Record<Status, Copy> = {
  idle: ['Software update', 'Check for updates', 'Check for a newer version.'],
  checking: ['Checking for updates…', 'Checking…', 'Checking the latest release.'],
  upToDate: ['You’re up to date', 'Check again', 'Latest version installed.'],
  available: ['Update available', 'Download update', 'Restart required to install.'],
  downloading: ['Downloading update', 'Downloading…', 'You can keep using the remote.'],
  ready: ['Ready to install', 'Install & restart', 'Downloaded and verified.'],
  installing: ['Installing update', 'Installing…', 'The app will restart automatically.'],
  error: ['Update failed', 'Try again', 'You can keep using the current version.'],
};

/** Owns the updater resource so downloads continue while this sheet is dismissed. */
export function initUpdater(): void {
  const dialog = document.getElementById('updateDialog') as HTMLDialogElement;
  const pill = document.getElementById('updatePill') as HTMLButtonElement;
  const primary = document.getElementById('updatePrimary') as HTMLButtonElement;
  const later = document.getElementById('updateLater') as HTMLButtonElement;
  const autoCheck = document.getElementById('settingsAutoUpdate') as HTMLInputElement;
  const settingsButton = document.getElementById('settingsUpdateBtn') as HTMLButtonElement;
  const progress = document.getElementById('updateProgress') as HTMLProgressElement;
  let update: Update | undefined;
  let status: Status = 'idle';
  let failed: FailedOperation | undefined;
  let error: string | undefined;
  let version = '';
  let downloaded = 0;
  let total: number | undefined;
  let finished = false;
  let bytesReady = false;
  let installed = false;
  let automatic = localStorage.getItem(AUTO_CHECK_KEY) !== 'false';

  function text(id: string, value: string): void {
    document.getElementById(id)!.textContent = value;
  }

  function visible(id: string, show: boolean): void {
    document.getElementById(id)!.hidden = !show;
  }

  function isBusy(): boolean {
    return ['checking', 'downloading', 'installing'].includes(status);
  }

  function render(): void {
    const [title, action, description] = COPY[status];
    pill.hidden = !update || status === 'checking';
    let pillLabel = title;
    if (status === 'ready') pillLabel = 'Update ready';
    if (status === 'error') pillLabel = 'Update needs attention';
    text('updatePillLabel', pillLabel);
    text('settingsAppVersion', version ? `Version ${version}` : 'Apple TV Remote');
    autoCheck.checked = automatic;
    primary.disabled = isBusy();
    later.disabled = status === 'installing';
    let dismiss = update ? 'Later' : 'Done';
    if (status === 'downloading') dismiss = 'Keep using remote';
    text('updateLater', dismiss);
    text('updateTitle', title);
    text('updateDescription', description);
    text('updatePrimary', action);
    text('updateVersion', update ? `${version} → ${update.version}` : `Version ${version || '—'}`);
    visible('updateVersion', Boolean(version));
    visible('updateNotesSection', Boolean(update?.body) && ['available', 'ready'].includes(status));
    text('updateNotes', update?.body ?? '');
    text('updateError', error ?? '');
    visible('updateError', Boolean(error));
    visible('updateProgressSection', status === 'downloading' || status === 'installing');
    let label = `${(downloaded / 1048576).toFixed(1)} MB downloaded`;
    if (status === 'installing') label = 'Installing and restarting…';
    if (finished && status === 'downloading') label = 'Verifying signature…';
    if (status === 'downloading' && total) {
      const percent = Math.min(100, (downloaded / total) * 100);
      progress.value = percent;
      if (!finished)
        label = `${(downloaded / 1048576).toFixed(1)} of ${(total / 1048576).toFixed(1)} MB · ${Math.floor(percent)}%`;
    } else {
      progress.removeAttribute('value');
    }
    text('updateProgressLabel', label);
  }

  async function execute(
    next: Status,
    operation: FailedOperation,
    task: () => Promise<void>,
  ): Promise<void> {
    if (isBusy()) return;
    status = next;
    error = undefined;
    failed = undefined;
    render();
    try {
      await task();
    } catch (reason) {
      status = 'error';
      failed = operation;
      error = reason instanceof Error ? reason.message : String(reason);
    }
    render();
  }

  function checkForUpdate(): void {
    if (update) return;
    void execute('checking', 'check', async () => {
      update = (await check()) ?? undefined;
      status = update ? 'available' : 'upToDate';
    });
  }

  function download(): void {
    if (!update || bytesReady) return;
    downloaded = 0;
    total = undefined;
    finished = false;
    void execute('downloading', 'download', async () => {
      await update!.download((event) => {
        if (event.event === 'Started') total = event.data.contentLength;
        else if (event.event === 'Progress') downloaded += event.data.chunkLength;
        else finished = true;
        render();
      });
      bytesReady = true;
      status = 'ready';
    });
  }

  function install(): void {
    if (!update || !bytesReady) return;
    if (installed) {
      void execute('installing', 'restart', desktopAPI.restart);
      return;
    }
    void execute('installing', 'install', async () => {
      await update!.install();
      installed = true;
      await desktopAPI.restart();
    });
  }

  function retry(): void {
    if (failed === 'download') download();
    else if (failed === 'install' || failed === 'restart') install();
    else checkForUpdate();
  }

  function open(checkNow: boolean): void {
    if (!dialog.open) dialog.showModal();
    render();
    if (checkNow && !update) checkForUpdate();
    if (dialog.open) (primary.disabled ? later : primary).focus();
  }

  primary.addEventListener('click', () => {
    if (status === 'available') download();
    else if (status === 'ready') install();
    else if (status === 'error') retry();
    else checkForUpdate();
  });
  later.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', (event) => {
    if (status === 'installing') event.preventDefault();
  });
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
    automatic = autoCheck.checked;
    localStorage.setItem(AUTO_CHECK_KEY, String(automatic));
  });
  desktopAPI.onContextMenuAction((action) => {
    if (action === 'openUpdates') void open(true);
  });
  void Promise.all([getVersion(), desktopAPI.isDevelopment()])
    .then(([currentVersion, development]) => {
      version = currentVersion;
      render();
      if (!development) {
        window.setTimeout(() => {
          if (automatic) checkForUpdate();
          window.setInterval(() => {
            if (automatic) checkForUpdate();
          }, DAY);
        }, 15_000);
      }
    })
    .catch((reason: unknown) => console.error('Unable to initialize updater:', reason));
  render();
}

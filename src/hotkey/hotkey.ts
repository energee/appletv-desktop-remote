import { desktopAPI } from '../shared/desktop-api';

const DEFAULT_HOTKEY = 'Super+Shift+R';
const modOrder = ['Super', 'Ctrl', 'Alt', 'Shift'];
const isMac = navigator.platform.startsWith('Mac');
const modifierLabels: Record<string, string> = isMac
  ? { Super: '⌘ Cmd', Ctrl: '⌃ Ctrl', Alt: '⌥ Alt', Shift: '⇧ Shift' }
  : { Super: 'Win', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
const displayModifiers: Record<string, string> = isMac
  ? { Super: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' }
  : { Super: 'Win', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
let pending = false;
let retryAction: (() => Promise<void>) | null = null;

if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
  document.body.classList.add('darkMode');
}

// Populate key dropdown
(function populateKeys() {
  const sel = document.getElementById('keySelect') as HTMLSelectElement;
  for (let i = 65; i <= 90; i++) {
    const opt = document.createElement('option');
    opt.value = String.fromCharCode(i);
    opt.textContent = String.fromCharCode(i);
    sel.appendChild(opt);
  }
  for (let n = 0; n <= 9; n++) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = String(n);
    sel.appendChild(opt);
  }
})();

for (const pill of document.querySelectorAll<HTMLButtonElement>('.mod-pill')) {
  const modifier = pill.dataset.mod!;
  pill.textContent = modifierLabels[modifier];
}
document.getElementById('resetBtn')!.title = isMac
  ? 'Clear custom shortcut and use ⌘⇧R'
  : 'Clear custom shortcut and use Win Shift R';

document.getElementById('modifierRow')!.addEventListener('click', function (e) {
  const pill = (e.target as HTMLElement).closest('.mod-pill') as HTMLButtonElement | null;
  if (!pill || pending) return;
  pill.classList.toggle('active');
  updatePreview();
});

document.getElementById('keySelect')!.addEventListener('change', function () {
  if (!pending) updatePreview();
});

function getActiveMods(): string[] {
  const mods: string[] = [];
  for (const pill of document.querySelectorAll('.mod-pill.active')) {
    mods.push((pill as HTMLElement).dataset.mod!);
  }
  mods.sort((a, b) => modOrder.indexOf(a) - modOrder.indexOf(b));
  return mods;
}

function getSelectedKey(): string {
  return (document.getElementById('keySelect') as HTMLSelectElement).value;
}

function buildComboString(): string {
  const parts = getActiveMods();
  const key = getSelectedKey();
  if (key) parts.push(key);
  return parts.join('+');
}

function buildDisplayString(): string {
  const modifiers = getActiveMods().map((modifier) => displayModifiers[modifier] || modifier);
  const key = getSelectedKey();
  if (key) modifiers.push(key);
  return modifiers.join(' ');
}

function updatePreview(): void {
  if (pending) return;

  // A global shortcut needs a key and a modifier other than Shift; a bare or shifted key would
  // be taken from typing in every app.
  (document.getElementById('saveBtn') as HTMLButtonElement).disabled =
    !getSelectedKey() || !getActiveMods().some((mod) => mod !== 'Shift');
  const el = document.getElementById('liveHotkey')!;
  const display = buildDisplayString();
  if (display) {
    el.textContent = display;
    el.classList.remove('empty');
  } else {
    el.textContent = 'Select modifiers and a key';
    el.classList.add('empty');
  }
}

function setModifiersFromCombo(combo: string): void {
  for (const p of document.querySelectorAll('.mod-pill')) {
    p.classList.remove('active');
  }
  (document.getElementById('keySelect') as HTMLSelectElement).value = '';

  const parts = combo.split('+').map((p) => p.trim());
  const modMap: Record<string, string> = {
    Super: 'Super',
    SUPER: 'Super',
    META: 'Super',
    Command: 'Super',
    Cmd: 'Super',
    CommandOrControl: 'Super',
    CmdOrCtrl: 'Super',
    Control: 'Ctrl',
    CONTROL: 'Ctrl',
    Ctrl: 'Ctrl',
    Alt: 'Alt',
    ALT: 'Alt',
    Option: 'Alt',
    Shift: 'Shift',
    SHIFT: 'Shift',
  };
  for (const part of parts) {
    const mapped = modMap[part];
    if (mapped) {
      const pill = document.querySelector(`.mod-pill[data-mod="${mapped}"]`);
      if (pill) pill.classList.add('active');
    } else {
      (document.getElementById('keySelect') as HTMLSelectElement).value = part.toUpperCase();
    }
  }
  updatePreview();
}

function setPendingState(operation: string): void {
  pending = true;
  for (const control of document.querySelectorAll<HTMLButtonElement>(
    '.mod-pill, #saveBtn, #resetBtn',
  )) {
    control.disabled = true;
  }
  (document.getElementById('keySelect') as HTMLSelectElement).disabled = true;
  const status = document.getElementById('hotkeyStatus')!;
  status.textContent = `${operation}…`;
  status.hidden = false;
}

function clearPendingState(): void {
  pending = false;
  for (const control of document.querySelectorAll<HTMLButtonElement>(
    '.mod-pill, #saveBtn, #resetBtn',
  )) {
    control.disabled = false;
  }
  (document.getElementById('keySelect') as HTMLSelectElement).disabled = false;
  const status = document.getElementById('hotkeyStatus')!;
  status.textContent = '';
  status.hidden = true;
  updatePreview();
}

function clearError(): void {
  document.getElementById('hotkeyErrorText')!.textContent = '';
  document.getElementById('hotkeyError')!.hidden = true;

  const retry = document.getElementById('retryBtn') as HTMLButtonElement;
  retry.hidden = true;
}

function showError(operation: string, error: unknown, action: () => Promise<void>): void {
  const detail = error instanceof Error ? error.message : String(error);
  const message = detail ? `Unable to ${operation}: ${detail}` : `Unable to ${operation}.`;
  document.getElementById('hotkeyErrorText')!.textContent = message;
  document.getElementById('hotkeyError')!.hidden = false;
  const retry = document.getElementById('retryBtn') as HTMLButtonElement;
  retry.textContent = `Retry ${operation}`;
  retry.hidden = false;
  retryAction = action;
}

async function runOperation(operation: string, request: () => Promise<void>): Promise<void> {
  if (pending) return;

  retryAction = null;
  clearError();
  setPendingState(`${operation[0].toUpperCase()}${operation.slice(1)} hotkey`);
  try {
    await request();
  } catch (error) {
    showError(operation, error, () => runOperation(operation, request));
  } finally {
    clearPendingState();
  }
}

async function loadExistingHotkey(): Promise<void> {
  await runOperation('load', async () => {
    const raw = await desktopAPI.loadHotkey();
    if (!raw) {
      setModifiersFromCombo(DEFAULT_HOTKEY);
      return;
    }

    const firstHotkey = raw
      .split(',')
      .map((hotkey) => hotkey.trim())
      .find((hotkey) => hotkey !== '');
    if (firstHotkey) setModifiersFromCombo(firstHotkey);
    else setModifiersFromCombo(DEFAULT_HOTKEY);
  });
}

async function saveHotkey(): Promise<void> {
  await runOperation('save', async () => {
    const combo = buildComboString();
    if (!combo) return;
    await desktopAPI.saveHotkey(combo);
    await desktopAPI.closeHotkeyWindow();
  });
}

async function resetToDefault(): Promise<void> {
  await runOperation('reset', async () => {
    await desktopAPI.resetHotkey();
    await desktopAPI.closeHotkeyWindow();
  });
}

document.getElementById('saveBtn')!.addEventListener('click', () => void saveHotkey());
document.getElementById('resetBtn')!.addEventListener('click', () => void resetToDefault());
document.getElementById('retryBtn')!.addEventListener('click', () => {
  if (retryAction) void retryAction();
});

void loadExistingHotkey();

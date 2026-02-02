import * as path from 'path';
import * as fs from 'fs';

const remote = require('@electron/remote');

const MYPATH = path.join(
  process.env.APPDATA ||
    (process.platform === 'darwin'
      ? process.env.HOME + '/Library/Application Support'
      : process.env.HOME + '/.local/share'),
  'ATV Remote',
);
const hotkeyPath = path.join(MYPATH, 'hotkey.txt');

const DEFAULT_HOTKEY = 'Super+Shift+R';
const symbolMap: Record<string, string> = {
  Super: '\u2318',
  Ctrl: '\u2303',
  Alt: '\u2325',
  Shift: '\u21E7',
};
const modOrder = ['Super', 'Ctrl', 'Alt', 'Shift'];

// Detect dark mode
if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
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

// Toggle modifier pills
document.getElementById('modifierRow')!.addEventListener('click', function (e) {
  const pill = (e.target as HTMLElement).closest('.mod-pill') as HTMLElement | null;
  if (!pill) return;
  pill.classList.toggle('active');
  updatePreview();
});

document.getElementById('keySelect')!.addEventListener('change', updatePreview);

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
  const mods = getActiveMods();
  const symbols = mods.map((m) => symbolMap[m] || m);
  const key = getSelectedKey();
  if (key) symbols.push(key);
  return symbols.join(' ');
}

function updatePreview(): void {
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
    Command: 'Super',
    Cmd: 'Super',
    CommandOrControl: 'Super',
    CmdOrCtrl: 'Super',
    Control: 'Ctrl',
    Ctrl: 'Ctrl',
    Alt: 'Alt',
    Option: 'Alt',
    Shift: 'Shift',
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

function loadExistingHotkey(): boolean {
  if (fs.existsSync(hotkeyPath)) {
    const raw = fs.readFileSync(hotkeyPath, 'utf8').trim();
    if (raw) {
      const hotkeys = raw
        .split(',')
        .map((h) => h.trim())
        .filter((h) => h !== '');
      if (hotkeys.length > 0) {
        setModifiersFromCombo(hotkeys[0]);
        return true;
      }
    }
  }
  setModifiersFromCombo(DEFAULT_HOTKEY);
  return false;
}

function saveHotkey(): void {
  const combo = buildComboString();
  if (!combo) return;

  let existing: string[] = [];
  if (fs.existsSync(hotkeyPath)) {
    const raw = fs.readFileSync(hotkeyPath, 'utf8').trim();
    if (raw) {
      existing = raw
        .split(',')
        .map((h) => h.trim())
        .filter((h) => h !== '');
    }
  }

  if (existing.length > 1) {
    existing[0] = combo;
    fs.writeFileSync(hotkeyPath, existing.join(','));
  } else {
    fs.writeFileSync(hotkeyPath, combo);
  }

  closeWindow();
}

function resetToDefault(): void {
  if (fs.existsSync(hotkeyPath)) {
    fs.unlinkSync(hotkeyPath);
  }
  closeWindow();
}

function closeWindow(): void {
  const win = remote.getCurrentWindow();
  win.close();
}

// Expose to HTML onclick handlers
(window as any).saveHotkey = saveHotkey;
(window as any).resetToDefault = resetToDefault;

// Init
loadExistingHotkey();

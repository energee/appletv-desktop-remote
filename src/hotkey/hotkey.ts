import { desktopAPI } from '../shared/desktop-api';
const DEFAULT_HOTKEY = 'Super+Shift+R';
const symbolMap: Record<string, string> = {
  Super: '\u2318',
  Ctrl: '\u2303',
  Alt: '\u2325',
  Shift: '\u21E7',
};
const modOrder = ['Super', 'Ctrl', 'Alt', 'Shift'];

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

async function loadExistingHotkey(): Promise<boolean> {
  const raw = await desktopAPI.loadHotkey();
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
  setModifiersFromCombo(DEFAULT_HOTKEY);
  return false;
}

async function saveHotkey(): Promise<void> {
  const combo = buildComboString();
  if (!combo) return;
  await desktopAPI.saveHotkey(combo);
  await desktopAPI.closeHotkeyWindow();
}

async function resetToDefault(): Promise<void> {
  await desktopAPI.resetHotkey();
  await desktopAPI.closeHotkeyWindow();
}

// Attach click handlers via addEventListener (no inline onclick)
document.getElementById('saveBtn')!.addEventListener('click', saveHotkey);
document.getElementById('resetBtn')!.addEventListener('click', resetToDefault);

// Init
loadExistingHotkey();

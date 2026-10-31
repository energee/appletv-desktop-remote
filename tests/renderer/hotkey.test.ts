import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (event: { target: TestElement }) => void;

class TestClassList {
  private readonly names = new Set<string>();

  add(name: string): void {
    this.names.add(name);
  }

  remove(name: string): void {
    this.names.delete(name);
  }

  toggle(name: string): boolean {
    if (this.names.has(name)) {
      this.names.delete(name);
      return false;
    }
    this.names.add(name);
    return true;
  }

  contains(name: string): boolean {
    return this.names.has(name);
  }
}

class TestElement {
  readonly classList = new TestClassList();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  disabled = false;
  hidden = false;
  textContent = '';
  title = '';
  value = '';

  constructor(
    readonly id: string,
    classes: string[] = [],
  ) {
    for (const className of classes) this.classList.add(className);
  }

  addEventListener(name: string, listener: Listener): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  appendChild(): void {}

  closest(selector: string): TestElement | null {
    return selector === '.mod-pill' && this.classList.contains('mod-pill') ? this : null;
  }

  fire(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener({ target: this });
  }
}

interface HotkeyPage {
  elements: Record<string, TestElement>;
  modifiers: TestElement[];
}

const desktopAPI = {
  closeHotkeyWindow: vi.fn(),
  loadHotkey: vi.fn(),
  resetHotkey: vi.fn(),
  saveHotkey: vi.fn(),
};

vi.mock('../../src/shared/desktop-api', () => ({ desktopAPI }));

function createPage(): HotkeyPage {
  const elements: Record<string, TestElement> = {
    liveHotkey: new TestElement('liveHotkey', ['live-hotkey', 'empty']),
    modifierRow: new TestElement('modifierRow', ['modifier-row']),
    keySelect: new TestElement('keySelect', ['key-select']),
    saveBtn: new TestElement('saveBtn', ['btn']),
    resetBtn: new TestElement('resetBtn', ['btn']),
    hotkeyStatus: new TestElement('hotkeyStatus', ['hotkey-message']),
    hotkeyError: new TestElement('hotkeyError', ['hotkey-message', 'hotkey-error']),
    hotkeyErrorText: new TestElement('hotkeyErrorText'),
    retryBtn: new TestElement('retryBtn', ['retry-btn']),
  };
  elements.hotkeyStatus.hidden = true;
  elements.hotkeyError.hidden = true;
  elements.retryBtn.hidden = true;

  const modifiers = ['Super', 'Ctrl', 'Alt', 'Shift'].map((modifier) => {
    const pill = new TestElement(modifier, ['mod-pill']);
    pill.dataset.mod = modifier;
    return pill;
  });

  const document = {
    body: new TestElement('body'),
    createElement: () => new TestElement('option'),
    getElementById: (id: string) => elements[id] ?? null,
    querySelector: (selector: string) => {
      const modifier = selector.match(/^\.mod-pill\[data-mod="(.+)"\]$/)?.[1];
      return modifier ? (modifiers.find((pill) => pill.dataset.mod === modifier) ?? null) : null;
    },
    querySelectorAll: (selector: string) => {
      if (selector === '.mod-pill') return modifiers;
      if (selector === '.mod-pill.active') {
        return modifiers.filter((pill) => pill.classList.contains('active'));
      }
      if (selector === '.mod-pill, #saveBtn, #resetBtn') {
        return [...modifiers, elements.saveBtn, elements.resetBtn];
      }
      return [];
    },
  };
  vi.stubGlobal('document', document);
  return { elements, modifiers };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function loadHotkeyPage(platform: string, hotkey: string | null = null): Promise<HotkeyPage> {
  const page = createPage();
  vi.stubGlobal('navigator', { platform });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  desktopAPI.loadHotkey.mockResolvedValue(hotkey);
  // The module initializes the hotkey page at import time, so each fixture needs a fresh load.
  await import('../../src/hotkey/hotkey');
  await settle();
  return page;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  desktopAPI.closeHotkeyWindow.mockResolvedValue(undefined);
  desktopAPI.resetHotkey.mockResolvedValue(undefined);
  desktopAPI.saveHotkey.mockResolvedValue(undefined);
});

describe('hotkey editor failures', () => {
  it('keeps the selection visible after a save failure and retries it', async () => {
    const page = await loadHotkeyPage('MacIntel', 'Super+Shift+P');
    desktopAPI.saveHotkey.mockRejectedValueOnce(new Error('registration conflict'));

    page.elements.saveBtn.fire('click');
    await settle();

    expect(desktopAPI.saveHotkey).toHaveBeenCalledWith('Super+Shift+P');
    expect(desktopAPI.closeHotkeyWindow).not.toHaveBeenCalled();
    expect(page.elements.liveHotkey.textContent).toBe('⌘ ⇧ P');
    expect(page.elements.hotkeyErrorText.textContent).toContain('registration conflict');
    expect(page.elements.retryBtn.hidden).toBe(false);

    page.elements.retryBtn.fire('click');
    await settle();

    expect(desktopAPI.saveHotkey).toHaveBeenCalledTimes(2);
    expect(desktopAPI.closeHotkeyWindow).toHaveBeenCalledTimes(1);
  });

  it('does not start conflicting saves while a save is pending', async () => {
    const page = await loadHotkeyPage('MacIntel');
    const save = Promise.withResolvers<void>();
    desktopAPI.saveHotkey.mockReturnValue(save.promise);

    page.elements.saveBtn.fire('click');
    page.elements.saveBtn.fire('click');

    expect(desktopAPI.saveHotkey).toHaveBeenCalledTimes(1);
    expect(page.elements.saveBtn.disabled).toBe(true);
    expect(page.elements.resetBtn.disabled).toBe(true);
    expect(page.elements.keySelect.disabled).toBe(true);
    expect(page.modifiers.every((pill) => pill.disabled)).toBe(true);

    save.resolve();
    await settle();
    expect(desktopAPI.closeHotkeyWindow).toHaveBeenCalledTimes(1);
  });

  it('keeps the window open after reset failure and retries reset', async () => {
    const page = await loadHotkeyPage('MacIntel');
    desktopAPI.resetHotkey.mockRejectedValueOnce(new Error('disk unavailable'));

    page.elements.resetBtn.fire('click');
    await settle();

    expect(desktopAPI.closeHotkeyWindow).not.toHaveBeenCalled();
    expect(page.elements.hotkeyErrorText.textContent).toContain('disk unavailable');

    page.elements.retryBtn.fire('click');
    await settle();

    expect(desktopAPI.resetHotkey).toHaveBeenCalledTimes(2);
    expect(desktopAPI.closeHotkeyWindow).toHaveBeenCalledTimes(1);
  });

  it('shows a load error without replacing the current input and can retry loading', async () => {
    desktopAPI.loadHotkey.mockRejectedValueOnce(new Error('settings unreadable'));
    const page = createPage();
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    // The module initializes the hotkey page at import time, so this rejected startup is isolated.
    await import('../../src/hotkey/hotkey');
    await settle();

    expect(page.elements.keySelect.value).toBe('');
    expect(page.modifiers.some((pill) => pill.classList.contains('active'))).toBe(false);
    expect(page.elements.hotkeyErrorText.textContent).toContain('settings unreadable');

    desktopAPI.loadHotkey.mockResolvedValue('Super+Shift+K');
    page.elements.retryBtn.fire('click');
    await settle();

    expect(page.elements.liveHotkey.textContent).toBe('⌘ ⇧ K');
    expect(page.elements.hotkeyError.hidden).toBe(true);
  });
});

describe('hotkey editor platform presentation', () => {
  it('presents Windows modifier names while saving the compatible serialized hotkey', async () => {
    const page = await loadHotkeyPage('Win32');

    expect(page.modifiers.map((pill) => pill.textContent)).toEqual(['Win', 'Ctrl', 'Alt', 'Shift']);
    expect(page.elements.liveHotkey.textContent).toBe('Win Shift R');
    expect(page.elements.resetBtn.title).toContain('Win Shift R');

    page.elements.saveBtn.fire('click');
    await settle();
    expect(desktopAPI.saveHotkey).toHaveBeenCalledWith('Super+Shift+R');
  });

  it('retains macOS glyphs and reset hint', async () => {
    const page = await loadHotkeyPage('MacIntel');

    expect(page.modifiers.map((pill) => pill.textContent)).toEqual([
      '⌘ Cmd',
      '⌃ Ctrl',
      '⌥ Alt',
      '⇧ Shift',
    ]);
    expect(page.elements.liveHotkey.textContent).toBe('⌘ ⇧ R');
    expect(page.elements.resetBtn.title).toContain('⌘⇧R');
  });
});

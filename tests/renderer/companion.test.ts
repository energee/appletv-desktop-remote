import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionStatus } from '../../src/shared/companion-api';
import { initCompanion } from '../../src/renderer/companion';

const companionAPI = vi.hoisted(() => ({
  status: vi.fn(async () => ({ status: 'connected', identifier: 'tv' })),
  onState: vi.fn(),
  onTextFocus: vi.fn(),
  onTextInput: vi.fn(),
  apps: vi.fn(async () => []),
  startPair: vi.fn(async () => {}),
  setText: vi.fn(async (text: string) => text),
}));
vi.mock('../../src/shared/companion-api', () => ({ companionAPI }));
vi.mock('../../src/renderer/state', () => ({
  refreshDevices: vi.fn(),
  loadActiveDevice: () => ({ identifier: 'tv', name: 'TV', companionPaired: true }),
}));

// Minimal webview DOM, matching the existing renderer test convention.
class Element {
  hidden = false;
  disabled = false;
  checked = false;
  open = false;
  value = '';
  textContent = '';
  children: Element[] = [];
  get lastElementChild(): Element | null {
    return this.children.at(-1) ?? null;
  }
  private listeners = new Map<string, () => void>();
  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, listener);
  }
  fire(name: string): void {
    this.listeners.get(name)?.();
  }
  replaceChildren(...children: Element[]): void {
    this.children = children;
  }
  append(...children: Element[]): void {
    this.children.push(...children);
  }
  prepend(...children: Element[]): void {
    this.children.unshift(...children);
  }
  showModal(): void {
    this.open = true;
  }
  setAttribute(): void {}
  focus = vi.fn();
  insertAdjacentHTML(): void {}
  close(): void {
    this.open = false;
  }
  querySelector(): Element {
    return new Element();
  }
}

let elements: Map<string, Element>;
let dialog: Element;
function emit(next: CompanionStatus): void {
  companionAPI.onState.mock.calls[0][0](next);
}

beforeEach(async () => {
  vi.clearAllMocks();
  elements = new Map();
  const host = new Element();
  dialog = new Element();
  vi.stubGlobal('document', {
    body: new Element(),
    querySelector: (selector: string) =>
      selector === '#runningElements .remote-body' ? host : dialog,
    getElementById: (id: string) => {
      if (id === 'companionTools') return null;
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement: () => new Element(),
  });
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  vi.stubGlobal('localStorage', { getItem: () => null });
  initCompanion();
  await Promise.resolve();
  emit({ status: 'unpaired', identifier: null });
  emit({ status: 'connected', identifier: 'tv' });
});

afterEach(() => vi.unstubAllGlobals());

describe('Companion error recovery', () => {
  it.each(['connecting', 'unpaired', 'connected'] as const)(
    'clears an old connection error when the next state is %s without an error',
    (status) => {
      const banner = elements.get('companionError')!;
      emit({ identifier: 'tv', status: 'unavailable', error: 'Connection lost.' });
      expect(banner.hidden).toBe(false);

      emit({ identifier: 'tv', status });
      expect(banner.hidden).toBe(true);
    },
  );

  it('does not hide a current error even when the connection is recovered', () => {
    const banner = elements.get('companionError')!;
    emit({ identifier: 'tv', status: 'unavailable', error: 'Connection lost.' });
    emit({ identifier: 'tv', status: 'connected' });
    expect(banner.hidden).toBe(true);
    emit({ identifier: 'tv', status: 'connected', error: 'Text field is unavailable.' });
    expect(banner.hidden).toBe(false);
  });

  it('waits for saved Companion recovery instead of requesting another PIN', async () => {
    emit({ identifier: 'tv', status: 'unavailable', error: 'Connection lost.' });
    elements.get('companionApps')!.fire('click');

    expect(companionAPI.startPair).not.toHaveBeenCalled();
    expect(companionAPI.apps).not.toHaveBeenCalled();
    emit({ identifier: 'tv', status: 'connecting' });
    emit({ identifier: 'tv', status: 'connected' });
    await vi.waitFor(() => expect(companionAPI.apps).toHaveBeenCalledOnce());
    expect(companionAPI.startPair).not.toHaveBeenCalled();
  });

  it('offers explicit pairing instead of waiting when saved keys are rejected', async () => {
    emit({ identifier: 'tv', status: 'unpaired', error: 'Pairing was rejected.' });
    elements.get('companionApps')!.fire('click');
    expect(companionAPI.apps).not.toHaveBeenCalled();
    expect(companionAPI.startPair).not.toHaveBeenCalled();
    const actions = elements.get('companionActions')!;
    actions.children.at(-1)!.fire('click');
    await vi.waitFor(() => expect(companionAPI.startPair).toHaveBeenCalledOnce());
  });

  it('starts explicit re-pairing without running a stale waiting feature', async () => {
    emit({ identifier: 'tv', status: 'unavailable', error: 'Connection lost.' });
    elements.get('companionApps')!.fire('click');
    const actions = elements.get('companionActions')!;
    actions.children.at(-1)!.fire('click');
    await vi.waitFor(() => expect(companionAPI.startPair).toHaveBeenCalledOnce());

    emit({ identifier: 'tv', status: 'connected' });
    expect(companionAPI.apps).not.toHaveBeenCalled();
  });
});

describe('Keyboard access', () => {
  it('offers keyboard pairing before Companion is connected or a TV field is focused', async () => {
    emit({ status: 'unpaired', identifier: 'tv' });
    const keyboard = elements.get('companionKeyboard')!;
    expect(keyboard.hidden).toBe(false);
    expect(keyboard.disabled).toBe(false);
    keyboard.fire('click');
    expect(dialog.open).toBe(true);
    elements.get('companionActions')!.children.at(-1)!.fire('click');
    await vi.waitFor(() => expect(companionAPI.startPair).toHaveBeenCalledOnce());
  });

  it('keeps the keyboard open while waiting for a TV field, then enables and focuses text input', async () => {
    elements.get('companionKeyboard')!.fire('click');
    await Promise.resolve();
    const input = elements.get('companionContent')!.children[0];
    expect(dialog.open).toBe(true);
    expect(input.disabled).toBe(true);
    companionAPI.onTextFocus.mock.calls[0][0]({ focused: true });
    expect(input.disabled).toBe(true);
    companionAPI.onTextInput.mock.calls[0][0]({ text: 'existing' });
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('existing');
    expect(input.focus).toHaveBeenCalledOnce();

    companionAPI.onTextFocus.mock.calls[0][0]({ focused: false });
    expect(dialog.open).toBe(true);
    expect(input.disabled).toBe(true);
    expect(input.value).toBe('');
    expect(companionAPI.setText).not.toHaveBeenCalled();
  });
});

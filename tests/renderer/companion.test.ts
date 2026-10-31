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
}));
vi.mock('../../src/shared/companion-api', () => ({ companionAPI }));
vi.mock('../../src/renderer/state', () => ({
  refreshDevices: vi.fn(),
  loadActiveDevice: () => ({ identifier: 'tv', name: 'TV', companionPaired: true }),
}));

// Minimal webview DOM, matching the existing renderer test convention.
class Element {
  hidden = true;
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
  showModal(): void {
    this.open = true;
  }
  setAttribute(): void {}
  focus(): void {}
  insertAdjacentHTML(): void {}
  close(): void {
    this.open = false;
  }
  querySelector(): Element {
    return new Element();
  }
}

let elements: Map<string, Element>;
function emit(next: CompanionStatus): void {
  companionAPI.onState.mock.calls[0][0](next);
}

beforeEach(async () => {
  vi.clearAllMocks();
  elements = new Map();
  const host = new Element();
  const dialog = new Element();
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

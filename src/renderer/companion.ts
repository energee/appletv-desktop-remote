import { companionAPI } from '../shared/companion-api';
import type { CompanionStatus } from '../shared/companion-api';
import { refreshDevices } from './state';

let status: CompanionStatus = { status: 'unpaired', identifier: null };
let dialog: HTMLDialogElement;
let content: HTMLElement;
let title: HTMLElement;
let description: HTMLElement;
let actions: HTMLElement;
let dialogError: HTMLElement;
let inlineError: HTMLElement;
let inlineText: HTMLInputElement;
let keyboardText: HTMLInputElement | null = null;
let clearButton: HTMLButtonElement | null = null;
let smoothButton: HTMLButtonElement;
let smoothTouchEnabled = false;
let pairingOpen = false;
let operation = 0;
let waitingFeature: { current: number; action: () => Promise<void> } | null = null;
let field = 0;
let textFocused = false;
let textReady = false;
let desiredText = '';
let textDirty = false;
let textVersion = 0;
let writeToken = 0;
let writing = false;
let clearRequested = false;
let textTimer: ReturnType<typeof setTimeout> | undefined;

function button(label: string, action: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', action);
  return element;
}

function showError(error: unknown): void {
  const target = dialog?.open ? dialogError : inlineError;
  target.textContent = error instanceof Error ? error.message : String(error);
  target.hidden = false;
}

function showSheet(heading: string, note: string): void {
  title.textContent = heading;
  description.textContent = note;
  content.replaceChildren();
  actions.replaceChildren(button('Done', closeSheet));
  dialogError.hidden = true;
  keyboardText = null;
  clearButton = null;
  if (!dialog.open) dialog.showModal();
}

function closeSheet(): void {
  const cancelPairing = pairingOpen;
  dismissSheet();
  if (cancelPairing) void companionAPI.cancelPair().catch(showError);
}

function dismissSheet(): void {
  operation++;
  waitingFeature = null;
  pairingOpen = false;
  dialog.close();
  keyboardText = null;
  clearButton = null;
}

function renderText(): void {
  for (const input of [inlineText, keyboardText]) {
    if (!input) continue;
    if (input.value !== desiredText) input.value = desiredText;
    input.disabled = !textFocused || !textReady;
  }
  inlineText.hidden = !textFocused || status.status !== 'connected';
  if (clearButton) clearButton.disabled = !textFocused || !textReady;
}

function resetText(): void {
  field++;
  writeToken++;
  writing = false;
  clearTimeout(textTimer);
  desiredText = '';
  textDirty = textReady = textFocused = false;
  renderText();
}

function queueText(value: string): void {
  desiredText = value;
  textDirty = true;
  clearRequested = false;
  textVersion++;
  clearTimeout(textTimer);
  textTimer = setTimeout(() => void flushText(), 180);
}

async function flushText(): Promise<void> {
  if (writing || !textDirty || !textFocused || !textReady) return;
  const token = ++writeToken;
  const version = textVersion;
  const currentField = field;
  const value = desiredText;
  const clear = clearRequested;
  writing = true;
  try {
    const observed = await (clear ? companionAPI.clearText() : companionAPI.setText(value));
    if (token !== writeToken || currentField !== field) return;
    if (version === textVersion) {
      textDirty = false;
      desiredText = observed;
      renderText();
    }
  } catch (error) {
    if (token !== writeToken || currentField !== field) return;
    // Keep the user's text; another edit or Clear retries without an automatic request loop.
    showError(error);
  } finally {
    if (token === writeToken) {
      writing = false;
      if (textDirty && version !== textVersion) {
        clearTimeout(textTimer);
        textTimer = setTimeout(() => void flushText(), 180);
      }
    }
  }
}

async function requestFeature(heading: string, action: () => Promise<void>): Promise<void> {
  const current = ++operation;
  if (status.status === 'connected') {
    try {
      await action();
    } catch (error) {
      if (current === operation) showError(error);
    }
    return;
  }
  if (status.status === 'connecting') {
    showSheet(heading, 'Connecting Companion…');
    actions.replaceChildren(button('Cancel', closeSheet));
    waitingFeature = { current, action };
    return;
  }
  showSheet(heading, 'Pair Companion once to use apps, text input, and smooth touch.');
  actions.replaceChildren(
    button('Cancel', closeSheet),
    button('Show pairing code', () => {
      void beginPairing(heading, action, current);
    }),
  );
}

async function beginPairing(
  heading: string,
  action: () => Promise<void>,
  current: number,
): Promise<void> {
  pairingOpen = true;
  const start = actions.lastElementChild as HTMLButtonElement;
  start.disabled = true;
  try {
    await companionAPI.startPair();
    if (current !== operation) return;
    showSheet(heading, 'Enter the code shown on your Apple TV.');
    const pin = document.createElement('input');
    pin.inputMode = 'numeric';
    pin.autocomplete = 'one-time-code';
    pin.maxLength = 4;
    pin.setAttribute('aria-label', 'Companion pairing code');
    content.append(pin);
    const confirm = button('Pair', () => {
      if (!/^\d{4}$/.test(pin.value)) {
        pin.focus();
        return;
      }
      void finishPair(pin.value, action, current, confirm);
    });
    actions.replaceChildren(button('Cancel', closeSheet), confirm);
    pin.focus();
  } catch (error) {
    if (current === operation) {
      start.disabled = false;
      showError(error);
    }
  }
}

async function finishPair(
  pin: string,
  action: () => Promise<void>,
  current: number,
  confirm: HTMLButtonElement,
): Promise<void> {
  confirm.disabled = true;
  try {
    const saved = await companionAPI.finishPair(pin);
    if (current !== operation || !saved) return;
  } catch (error) {
    if (current !== operation) return;
    if (error instanceof Error && error.message.startsWith('Secure storage:')) {
      showError(error);
      confirm.textContent = 'Retry saving';
      confirm.disabled = false;
      // The native host retains the verified credentials; no new TV pairing is started.
      return;
    }
    await beginPairing('Companion pairing', action, current);
    if (current === operation) showError(error);
    return;
  }
  pairingOpen = false;
  dialog.close();
  if (current === operation) {
    try {
      await refreshDevices();
      if (current === operation) await action();
    } catch (error) {
      if (current === operation) showError(error);
    }
  }
}

async function openApps(): Promise<void> {
  await requestFeature('Apps', async () => {
    const current = operation;
    showSheet('Apps', 'Loading installed apps…');
    try {
      const apps = await companionAPI.apps();
      if (current !== operation) return;
      description.textContent = apps.length
        ? ''
        : 'No launchable apps were reported by this Apple TV.';
      const list = document.createElement('div');
      list.className = 'companion-apps';
      for (const app of apps) {
        const launch = button(app.name, () => {
          launch.disabled = true;
          void companionAPI
            .launchApp(app.bundleId)
            .then(() => {
              if (current === operation) closeSheet();
            })
            .catch((error: unknown) => {
              if (current === operation) {
                launch.disabled = false;
                showError(error);
              }
            });
        });
        list.append(launch);
      }
      content.append(list);
    } catch (error) {
      if (current !== operation) return;
      description.textContent = '';
      showError(error);
      actions.prepend(button('Retry', () => void openApps()));
    }
  });
}

async function openKeyboard(): Promise<void> {
  await requestFeature('Keyboard', async () => {
    showSheet('Keyboard', 'Select a text field on the Apple TV to edit it here.');
    keyboardText = document.createElement('input');
    keyboardText.setAttribute('aria-label', 'Apple TV text');
    keyboardText.addEventListener('input', () => queueText(keyboardText!.value));
    content.append(keyboardText);
    clearButton = button('Clear', () => {
      queueText('');
      clearRequested = true;
      clearTimeout(textTimer);
      renderText();
      void flushText();
    });
    actions.prepend(clearButton);
    renderText();
    if (textFocused && textReady) keyboardText.focus();
  });
}

export function companionKeyboardGuard(event: KeyboardEvent): boolean {
  const target = event.target;
  const editing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable);
  if (!editing && !dialog?.open) return false;
  event.stopImmediatePropagation();
  return true;
}

export function companionTouchAvailable(): boolean {
  return smoothTouchEnabled && status.status === 'connected';
}

export async function companionTouchAdapter(
  x: number,
  y: number,
  phase: 'press' | 'hold' | 'release',
): Promise<boolean> {
  if (status.status !== 'connected' || (phase !== 'release' && !smoothTouchEnabled)) return false;
  await companionAPI.touch(x, y, phase);
  return true;
}

export function initCompanion(): void {
  const host = document.getElementById('runningElements');
  if (!host || document.getElementById('companionTools')) return;
  host.insertAdjacentHTML(
    'beforeend',
    `
    <div id="companionTools" class="companion-tools">
      <button type="button" id="companionApps">Apps</button>
      <button type="button" id="companionKeyboard">Keyboard</button>
      <button type="button" id="companionSmooth" aria-pressed="false">Smooth touch</button>
    </div>
    <input id="companionText" aria-label="Apple TV text" autocomplete="off" hidden />
    <p id="companionError" class="companion-error" role="alert" hidden></p>`,
  );
  document.body.insertAdjacentHTML(
    'beforeend',
    `
    <dialog class="companion-dialog" aria-labelledby="companionTitle">
      <form><h2 id="companionTitle"></h2><p id="companionDescription"></p>
      <div id="companionContent"></div><p id="companionDialogError" class="companion-error" role="alert" hidden></p>
      <div id="companionActions" class="companion-actions"></div></form>
    </dialog>`,
  );
  dialog = document.querySelector('.companion-dialog')!;
  content = document.getElementById('companionContent')!;
  title = document.getElementById('companionTitle')!;
  description = document.getElementById('companionDescription')!;
  actions = document.getElementById('companionActions')!;
  dialogError = document.getElementById('companionDialogError')!;
  inlineError = document.getElementById('companionError')!;
  inlineText = document.getElementById('companionText') as HTMLInputElement;
  smoothButton = document.getElementById('companionSmooth') as HTMLButtonElement;
  document.getElementById('companionApps')!.addEventListener('click', () => void openApps());
  document
    .getElementById('companionKeyboard')!
    .addEventListener('click', () => void openKeyboard());
  smoothButton.addEventListener(
    'click',
    () =>
      void requestFeature('Smooth touch', async () => {
        smoothTouchEnabled = !smoothTouchEnabled;
        localStorage.setItem(
          `companion-smooth-touch:${status.identifier}`,
          String(smoothTouchEnabled),
        );
        smoothButton.setAttribute('aria-pressed', String(smoothTouchEnabled));
      }),
  );
  inlineText.addEventListener('input', () => queueText(inlineText.value));
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeSheet();
  });
  dialog.querySelector('form')!.addEventListener('submit', (event) => {
    event.preventDefault();
    (actions.lastElementChild as HTMLButtonElement)?.click();
  });
  window.addEventListener('keydown', companionKeyboardGuard, true);
  let receivedState = false;
  function applyState(next: CompanionStatus): void {
    const changedDevice = next.identifier !== status.identifier;
    if (changedDevice || (status.status === 'connected' && next.status !== 'connected')) {
      // Device replacement already cancels the sidecar session. Never cancel the new TV or
      // discard verified credentials awaiting a secure-storage retry on the same TV.
      if (changedDevice || !pairingOpen) dismissSheet();
      resetText();
    }
    status = next;
    smoothTouchEnabled =
      localStorage.getItem(`companion-smooth-touch:${next.identifier}`) === 'true';
    smoothButton.setAttribute('aria-pressed', String(smoothTouchEnabled));
    renderText();
    if (next.error) showError(new Error(next.error));
    if (waitingFeature?.current === operation && next.status === 'connected') {
      const { action } = waitingFeature;
      waitingFeature = null;
      dialog.close();
      void action().catch(showError);
    }
  }
  companionAPI.onState((next) => {
    receivedState = true;
    applyState(next);
  });
  companionAPI.onTextFocus(({ focused }) => {
    if (focused !== textFocused) resetText();
    textFocused = focused;
    renderText();
  });
  companionAPI.onTextInput(({ text }) => {
    const wasReady = textReady;
    textReady = true;
    if (!textDirty) {
      desiredText = text;
      renderText();
    }
    if (!wasReady && textFocused && !dialog.open) inlineText.focus();
  });
  void companionAPI
    .status()
    .then((next) => {
      if (!receivedState) applyState(next);
    })
    .catch(showError);
}

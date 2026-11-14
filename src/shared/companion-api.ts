import { backendRequest, desktopAPI } from './desktop-api';
import type { SavedDevice } from './types';

export interface CompanionStatus {
  status: 'unpaired' | 'pairing' | 'connecting' | 'connected' | 'unavailable';
  identifier: string | null;
  error?: string;
}

export interface TextFocusState {
  focused: boolean;
}

export interface TextInputState {
  text: string;
}

export interface CompanionApp {
  name: string;
  bundleId: string;
}

export const companionAPI = {
  status: () => backendRequest<CompanionStatus>('companionStatus'),
  startPair: () => backendRequest<void>('startCompanionPair'),
  finishPair: (pin: string) => backendRequest<SavedDevice | null>('finishCompanionPair', { pin }),
  cancelPair: () => backendRequest<void>('cancelCompanionPair'),
  apps: () => backendRequest<CompanionApp[]>('apps'),
  launchApp: (bundleId: string) => backendRequest<void>('launchApp', { bundleId }),
  /** Pops a native menu of `apps` at `position` in the window; a pick arrives by onAppChosen. */
  showAppsMenu: (apps: CompanionApp[], position: { x: number; y: number }) =>
    desktopAPI.showAppsMenu(apps, position),
  /** The bundle ID of the app picked from the menu showAppsMenu opened. */
  onAppChosen: (callback: (bundleId: string) => void) =>
    desktopAPI.onContextMenuAction((action, payload) => {
      if (action === 'launchApp' && payload) callback(payload);
    }),
  setText: (text: string) => backendRequest<string>('setText', { text }),
  clearText: () => backendRequest<string>('clearText'),
  touch: (x: number, y: number, phase: 'press' | 'hold' | 'release') =>
    backendRequest<void>('touch', { x, y, phase }),
  onState: (callback: (state: CompanionStatus) => void) => desktopAPI.onCompanionState(callback),
  onTextFocus: (callback: (state: TextFocusState) => void) => desktopAPI.onTextFocus(callback),
  onTextInput: (callback: (state: TextInputState) => void) => desktopAPI.onTextInput(callback),
};

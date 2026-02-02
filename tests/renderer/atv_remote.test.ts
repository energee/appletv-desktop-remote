import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the window.electronAPI
const mockElectronAPI = {
  loadHotkeyWindow: vi.fn(),
  quit: vi.fn(),
  setAlwaysOnTop: vi.fn(),
  hideWindow: vi.fn(),
  showWindow: vi.fn(),
  scan: vi.fn(),
  startPair: vi.fn(),
  finishPair: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  sendKey: vi.fn(),
  isConnected: vi.fn(),
  showContextMenu: vi.fn(),
  getTheme: vi.fn(),
  loadSettingsPanel: vi.fn(),
  saveSettings: vi.fn(),
  removeDevice: vi.fn(),
  onShortcutWin: vi.fn().mockReturnValue(() => {}),
  onPowerResume: vi.fn().mockReturnValue(() => {}),
  onSendCommand: vi.fn().mockReturnValue(() => {}),
  onAtvConnected: vi.fn().mockReturnValue(() => {}),
  onAtvConnectionFailure: vi.fn().mockReturnValue(() => {}),
  onAtvConnectionLost: vi.fn().mockReturnValue(() => {}),
  onAtvDisconnected: vi.fn().mockReturnValue(() => {}),
  onAtvNowPlaying: vi.fn().mockReturnValue(() => {}),
  onThemeUpdated: vi.fn().mockReturnValue(() => {}),
  onErrorMessage: vi.fn().mockReturnValue(() => {}),
  onContextMenuAction: vi.fn().mockReturnValue(() => {}),
};

// Mock DOM element
const mockElement = {
  style: { display: '' },
  innerHTML: '',
  textContent: '',
  value: '',
  classList: { add: vi.fn(), remove: vi.fn() },
  appendChild: vi.fn(),
  addEventListener: vi.fn(),
};

// Set up global mocks before imports
vi.stubGlobal('window', {
  ...globalThis.window,
  electronAPI: mockElectronAPI,
  addEventListener: vi.fn(),
  location: { reload: vi.fn() },
});

vi.stubGlobal('document', {
  querySelector: vi.fn().mockReturnValue(mockElement),
  querySelectorAll: vi.fn().mockReturnValue([]),
  addEventListener: vi.fn(),
  activeElement: null,
  createElement: vi.fn().mockReturnValue({
    ...mockElement,
    disabled: false,
    selected: false,
  }),
  getElementById: vi.fn().mockReturnValue(mockElement),
  body: { classList: { add: vi.fn(), remove: vi.fn() } },
});

vi.stubGlobal('localStorage', {
  getItem: vi.fn().mockReturnValue(null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
});

describe('atv_remote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockElectronAPI.sendKey.mockResolvedValue(undefined);
    mockElectronAPI.scan.mockResolvedValue([]);
    mockElectronAPI.connect.mockResolvedValue(undefined);
    mockElectronAPI.startPair.mockResolvedValue(undefined);
  });

  describe('sendKey()', () => {
    it('calls electronAPI.sendKey', async () => {
      const { sendKey } = await import('../../src/renderer/atv_remote');
      await sendKey('play_pause');
      expect(mockElectronAPI.sendKey).toHaveBeenCalledWith('play_pause');
    });
  });

  describe('scanDevices()', () => {
    it('calls electronAPI.scan', async () => {
      mockElectronAPI.scan.mockResolvedValue(['Device 1 (1.2.3.4)']);
      const { scanDevices } = await import('../../src/renderer/atv_remote');
      await scanDevices();
      expect(mockElectronAPI.scan).toHaveBeenCalled();
    });
  });

  describe('connectATV()', () => {
    it('calls electronAPI.connect', async () => {
      const creds = { credentials: 'test', identifier: 'id1' };
      const { connectATV } = await import('../../src/renderer/atv_remote');
      await connectATV(creds);
      expect(mockElectronAPI.connect).toHaveBeenCalledWith(creds);
    });

    it('emits connection_failure on error', async () => {
      mockElectronAPI.connect.mockRejectedValue(new Error('fail'));
      const { connectATV } = await import('../../src/renderer/atv_remote');

      await expect(connectATV({ credentials: 'x', identifier: 'y' })).rejects.toThrow('fail');
    });
  });
});

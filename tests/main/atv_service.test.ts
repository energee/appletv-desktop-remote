import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the node-appletv-remote module
const mockScan = vi.fn();
const mockDevice = {
  startPairing: vi.fn(),
  startCompanionPairing: vi.fn(),
  connect: vi.fn(),
  connectCompanion: vi.fn(),
  sendKeyCommand: vi.fn(),
  close: vi.fn(),
  removeAllListeners: vi.fn(),
  on: vi.fn(),
  deviceId: 'test-device-id',
  companionPort: 1234,
};
const _mockCredentials = {
  serialize: vi.fn().mockReturnValue('serialized-creds'),
  companionCredentials: 'companion-creds',
};
const mockPairingSession = {
  finish: vi.fn(),
};

// Use a proper class for AppleTV mock so it can be used with `new`
class MockAppleTV {
  startPairing = mockDevice.startPairing;
  startCompanionPairing = mockDevice.startCompanionPairing;
  connect = mockDevice.connect;
  connectCompanion = mockDevice.connectCompanion;
  sendKeyCommand = mockDevice.sendKeyCommand;
  close = mockDevice.close;
  removeAllListeners = mockDevice.removeAllListeners;
  on = mockDevice.on;
  deviceId = 'test-device-id';
  companionPort = 1234;
}

class MockCredentials {
  airplay: unknown;
  companion: unknown;
  companionCredentials: unknown;
  constructor(airplay: unknown, companion: unknown) {
    this.airplay = airplay;
    this.companion = companion;
    this.companionCredentials = 'companion-creds';
  }
  serialize() {
    return 'serialized-creds';
  }
  static deserialize(_data: unknown) {
    return {
      companionCredentials: 'companion-creds',
    };
  }
}

vi.mock('node-appletv-remote', () => ({
  scan: (...args: unknown[]) => mockScan(...args),
  AppleTV: MockAppleTV,
  Credentials: MockCredentials,
  Key: {
    PlayPause: 0,
    Left: 1,
    Right: 2,
    Down: 3,
    Up: 4,
    Select: 5,
    Menu: 6,
    TopMenu: 7,
    Home: 8,
    HomeHold: 9,
    SkipBackward: 10,
    SkipForward: 11,
    VolumeUp: 12,
    VolumeDown: 13,
  },
}));

// Dynamic import to get the module after mocks are set up
let ATVService: typeof import('../../src/main/atv_service').default;

beforeEach(async () => {
  vi.clearAllMocks();
  const mod = await import('../../src/main/atv_service');
  ATVService = mod.default;
});

describe('ATVService', () => {
  let service: InstanceType<typeof ATVService>;

  beforeEach(() => {
    service = new ATVService();
  });

  afterEach(async () => {
    await service.destroy();
  });

  describe('scan()', () => {
    it('returns formatted device labels', async () => {
      mockScan.mockResolvedValue([
        { name: 'Living Room', address: '192.168.1.10', port: 7000, deviceId: 'dev1' },
        { name: 'Bedroom', address: '192.168.1.11', port: 7000, deviceId: 'dev2' },
      ]);

      const results = await service.scan(1000);
      expect(results).toEqual(['Living Room (192.168.1.10)', 'Bedroom (192.168.1.11)']);
    });

    it('stores scan results for later pairing', async () => {
      mockScan.mockResolvedValue([
        { name: 'Living Room', address: '192.168.1.10', port: 7000, deviceId: 'dev1' },
      ]);

      await service.scan();
      expect(service.scanResults['Living Room (192.168.1.10)']).toBeDefined();
    });

    it('times out with safety net', async () => {
      mockScan.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 10000)),
      );

      await expect(service.scan(100)).rejects.toThrow('Scan timed out');
    });
  });

  describe('startPair()', () => {
    it('throws on unknown device', async () => {
      await expect(service.startPair('Unknown Device')).rejects.toThrow('Device not found');
    });

    it('sets pairing phase to airplay', async () => {
      mockScan.mockResolvedValue([
        { name: 'Test', address: '1.2.3.4', port: 7000, deviceId: 'dev1' },
      ]);
      await service.scan();

      mockDevice.startPairing.mockResolvedValue(mockPairingSession);
      await service.startPair('Test (1.2.3.4)');

      expect(service.pairingPhase).toBe('airplay');
      expect(service.pairingSession).toBe(mockPairingSession);
    });
  });

  describe('finishPair()', () => {
    beforeEach(async () => {
      mockScan.mockResolvedValue([
        { name: 'Test', address: '1.2.3.4', port: 7000, deviceId: 'dev1' },
      ]);
      await service.scan();
      mockDevice.startPairing.mockResolvedValue(mockPairingSession);
      await service.startPair('Test (1.2.3.4)');
    });

    it('handles airplay phase and requests companion pin', async () => {
      mockPairingSession.finish.mockResolvedValue('airplay-creds');
      mockDevice.startCompanionPairing.mockResolvedValue(mockPairingSession);

      const result = await service.finishPair('1234');
      expect(result.needsCompanionPin).toBe(true);
      expect(service.pairingPhase).toBe('companion');
    });

    it('handles companion phase and returns credentials', async () => {
      // First phase - airplay
      mockPairingSession.finish.mockResolvedValue('airplay-creds');
      mockDevice.startCompanionPairing.mockResolvedValue(mockPairingSession);
      await service.finishPair('1234');

      // Second phase - companion
      mockPairingSession.finish.mockResolvedValue('companion-creds');
      const result = await service.finishPair('5678');

      expect(result.credentials).toBe('serialized-creds');
      expect(result.identifier).toBe('test-device-id');
      expect(service.pairingSession).toBeNull();
      expect(service.pairingPhase).toBeNull();
    });
  });

  describe('connect()', () => {
    it('emits connected on success', async () => {
      const connectedSpy = vi.fn();
      service.on('connected', connectedSpy);

      mockScan.mockResolvedValue([
        { name: 'Test', address: '1.2.3.4', port: 7000, deviceId: 'dev1', companionPort: 1234 },
      ]);
      mockDevice.connect.mockResolvedValue(undefined);
      mockDevice.connectCompanion.mockResolvedValue(undefined);

      await service.connect({ credentials: 'test-creds', identifier: 'dev1' });
      expect(connectedSpy).toHaveBeenCalled();
    });

    it('emits connection-failure when device not found', async () => {
      const failSpy = vi.fn();
      service.on('connection-failure', failSpy);

      mockScan.mockResolvedValue([]);

      await expect(
        service.connect({ credentials: 'test-creds', identifier: 'nonexistent' }),
      ).rejects.toThrow('Device not found on network');
      expect(failSpy).toHaveBeenCalled();
    });

    it('emits connection-failure on connect timeout', { timeout: 20000 }, async () => {
      const failSpy = vi.fn();
      service.on('connection-failure', failSpy);

      mockScan.mockResolvedValue([
        { name: 'Test', address: '1.2.3.4', port: 7000, deviceId: 'dev1' },
      ]);
      mockDevice.connect.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 20000)),
      );

      await expect(
        service.connect({ credentials: 'test-creds', identifier: 'dev1' }),
      ).rejects.toThrow('Connection timed out');
      expect(failSpy).toHaveBeenCalled();
    });
  });

  describe('sendKey()', () => {
    it('throws when not connected', async () => {
      await expect(service.sendKey('play_pause')).rejects.toThrow('Not connected');
    });

    it('throws on unknown key', async () => {
      // Set up a connected device via startPair (which creates the device)
      mockScan.mockResolvedValue([
        { name: 'Test', address: '1.2.3.4', port: 7000, deviceId: 'dev1' },
      ]);
      mockDevice.connect.mockResolvedValue(undefined);
      await service.connect({ credentials: 'creds', identifier: 'dev1' });

      await expect(service.sendKey('invalid_key' as never)).rejects.toThrow('Unknown key');
    });

    it('sends key command for all valid keys', async () => {
      mockScan.mockResolvedValue([
        { name: 'Test', address: '1.2.3.4', port: 7000, deviceId: 'dev1' },
      ]);
      mockDevice.connect.mockResolvedValue(undefined);
      mockDevice.sendKeyCommand.mockResolvedValue(undefined);
      await service.connect({ credentials: 'creds', identifier: 'dev1' });

      const keys = [
        'play_pause',
        'left',
        'right',
        'down',
        'up',
        'select',
        'menu',
        'top_menu',
        'home',
        'home_hold',
        'skip_backward',
        'skip_forward',
        'volume_up',
        'volume_down',
      ] as const;

      for (const key of keys) {
        await service.sendKey(key);
      }
      expect(mockDevice.sendKeyCommand).toHaveBeenCalledTimes(keys.length);
    });
  });

  describe('disconnect()', () => {
    it('emits disconnected event', async () => {
      const disconnectedSpy = vi.fn();
      service.on('disconnected', disconnectedSpy);

      await service.disconnect();
      expect(disconnectedSpy).toHaveBeenCalled();
    });
  });

  describe('destroy()', () => {
    it('cleans up all state', async () => {
      service.scanResults = { test: {} as never };
      service.pairingPhase = 'airplay';

      await service.destroy();

      expect(service.scanResults).toEqual({});
      expect(service.pairingSession).toBeNull();
      expect(service.pairingPhase).toBeNull();
      expect(service.airplayCreds).toBeNull();
    });
  });
});

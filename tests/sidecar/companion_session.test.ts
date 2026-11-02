import { afterEach, expect, it, vi } from 'vitest';
import { AppleTV } from '../../app/node_modules/node-appletv-remote/dist/appletv.js';
import { CompanionConnection } from '../../app/node_modules/node-appletv-remote/dist/companion/connection.js';
import { TlvTag, tlvEncode } from '../../app/node_modules/node-appletv-remote/dist/util/tlv.js';

afterEach(() => vi.restoreAllMocks());

it('lists installed apps immediately after Companion connects, without a first touch gesture', async () => {
  // Model the TV's handler registration, not a list of expected implementation calls.
  // A TV Remote client is accepted only after com.apple.tvremoteservices is open.
  let touchStarted = false;
  let remoteSession = false;
  let remoteClient = false;
  vi.spyOn(CompanionConnection.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(CompanionConnection.prototype, 'sendMessage').mockImplementation(() => {});
  vi.spyOn(CompanionConnection.prototype, 'sendRequest').mockImplementation(async (identifier) => {
    let content = new Map<string, unknown>();
    switch (identifier) {
      case '_systemInfo':
        break;
      case '_touchStart':
        touchStarted = true;
        content.set('_i', 1);
        break;
      case '_sessionStart':
        if (!touchStarted) throw new Error('Touch service is not open');
        remoteSession = true;
        content.set('_sid', 2);
        break;
      case 'TVRCSessionStart':
        if (!remoteSession) throw new Error('No request handler');
        remoteClient = true;
        break;
      case '_tiStart':
        if (!remoteClient) throw new Error('No request handler');
        break;
      case 'FetchLaunchableApplicationsEvent':
        if (!remoteClient) throw new Error('No request handler');
        content = new Map([['com.apple.TVWatchList', 'TV']]);
        break;
      case '_sessionStop':
        remoteSession = remoteClient = false;
        break;
      case '_touchStop':
        touchStarted = false;
        break;
      default:
        throw new Error(`Unexpected Companion request: ${identifier}`);
    }
    return new Map([['_c', content]]);
  });
  const tv = new AppleTV({
    name: 'Test TV',
    address: '127.0.0.1',
    port: 7000,
    deviceId: 'test-tv',
    model: 'AppleTV14,1',
  });
  try {
    await tv.connectCompanion(
      {
        clientId: 'test-controller',
        clientLTSK: Buffer.alloc(32),
        clientLTPK: Buffer.alloc(32),
        serverId: 'test-tv',
        serverLTPK: Buffer.alloc(32),
      },
      49152,
    );
    await expect(tv.appList()).resolves.toEqual([
      { name: 'TV', bundleId: 'com.apple.TVWatchList' },
    ]);
  } finally {
    await tv.close();
  }
});

it.each([2, 3, 6, 7])(
  'distinguishes authentication rejection from retryable Pair Verify error %i',
  async (errorCode) => {
    const connection = new CompanionConnection('127.0.0.1', 49152, {
      clientId: 'test-controller',
      clientLTSK: Buffer.alloc(32),
      clientLTPK: Buffer.alloc(32),
      serverId: 'test-tv',
      serverLTPK: Buffer.alloc(32),
    });
    // Inject a peer's TLV response; keep the real verification decoder and error propagation.
    const peer = connection as unknown as {
      openSocket(): Promise<void>;
      sendPairingData(): void;
      receivePairingData(): Promise<Buffer>;
    };
    vi.spyOn(peer, 'openSocket').mockResolvedValue(undefined);
    vi.spyOn(peer, 'sendPairingData').mockImplementation(() => {});
    vi.spyOn(peer, 'receivePairingData').mockResolvedValue(
      tlvEncode({ [TlvTag.SeqNo]: Buffer.from([2]), [TlvTag.Error]: Buffer.from([errorCode]) }),
    );
    const failure = await connection.connect().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { code?: string }).code).toBe(
      errorCode === 2 ? 'COMPANION_AUTHENTICATION_FAILED' : undefined,
    );
  },
);

import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sdk from '../../app/node_modules/node-appletv-remote/dist/index.js';
import { AirPlayConnection } from '../../app/node_modules/node-appletv-remote/dist/connection.js';
import * as mrp from '../../app/node_modules/node-appletv-remote/dist/mrp/messages.js';
import { MRP_SCHEMA } from '../../app/node_modules/node-appletv-remote/dist/mrp/schema.js';
import ATVService from '../../src/sidecar/atv_service';
import type { NowPlayingInfo } from '../../src/shared/types';

const { MRPMessage, MessageType } = mrp;

const discovered = {
  name: 'Offline TV',
  address: 'offline',
  port: 7000,
  deviceId: 'fixture-tv',
  model: 'AppleTV6,2',
};
vi.mock('node-appletv-remote', () => ({
  ...sdk,
  scan: async () => [discovered],
}));
vi.mock('node-appletv-remote/dist/mrp/messages.js', () => mrp);

const requireSdk = createRequire(
  import.meta.resolve('../../app/node_modules/node-appletv-remote/dist/mrp/messages.js'),
);
const protobuf = requireSdk('protobufjs');
const protocol = protobuf.Root.fromJSON(MRP_SCHEMA).lookupType('ProtocolMessage');
const playerPath = {
  client: { bundleIdentifier: 'fixture.app', displayName: 'Fixture App' },
  player: { identifier: 'MediaRemote-DefaultPlayer' },
};
const credentials = new sdk.Credentials({
  clientId: 'fixture-controller',
  serverId: 'fixture-tv',
  clientLTSK: Buffer.alloc(32),
  clientLTPK: Buffer.alloc(32),
  serverLTPK: Buffer.alloc(32),
});

let service: ATVService;
let observed: NowPlayingInfo[];
let errors: Error[];
let stateOnly: boolean;
let replyError: number | undefined;

async function receive(
  connection: AirPlayConnection,
  message: Record<string, unknown>,
): Promise<void> {
  const bytes = Buffer.from(protocol.encode(protocol.fromObject(message)).finish());
  await Reflect.get(connection, 'handleMRPResponse').call(connection, bytes);
}

beforeEach(() => {
  vi.useFakeTimers();
  stateOnly = false;
  replyError = undefined;
  observed = [];
  errors = [];
  service = new ATVService();
  service.on('now-playing', (info: NowPlayingInfo) => observed.push(info));
  service.on('error', (error: Error) => errors.push(error));
  vi.spyOn(AirPlayConnection.prototype, 'connect').mockImplementation(async function () {
    await Reflect.get(this, 'initMRPProtocol').call(this);
  });
  vi.spyOn(AirPlayConnection.prototype, 'sendMRPMessage').mockImplementation(
    async function (bytes) {
      const request = await MRPMessage.decode(bytes);
      if (request.type === MessageType.DeviceInfo) {
        await receive(this, { type: MessageType.DeviceInfo });
      } else if (request.type === MessageType.ClientUpdatesConfig && stateOnly) {
        await receive(this, {
          type: MessageType.SetNowPlayingClient,
          '.setNowPlayingClientMessage': { client: playerPath.client },
        });
        await receive(this, {
          type: MessageType.SetNowPlayingPlayer,
          '.setNowPlayingPlayerMessage': { playerPath },
        });
        await receive(this, {
          type: MessageType.SetState,
          '.setStateMessage': { playerPath, playbackState: 1 },
        });
      } else if (request.type === MessageType.PlaybackQueueRequest) {
        // This receiver already has a playing item, but sends metadata only on request.
        if (replyError !== undefined) {
          await receive(this, {
            identifier: request.identifier,
            errorCode: replyError,
            errorDescription: 'No current playback client',
          });
        } else {
          await receive(this, {
            type: MessageType.SetState,
            identifier: request.identifier,
            '.setStateMessage': {
              playerPath,
              playbackState: 1,
              playbackQueue: {
                location: 0,
                contentItems: [
                  {
                    identifier: 'fixture-item',
                    metadata: {
                      title: 'Fixture Movie',
                      duration: 600,
                      elapsedTime: 30,
                      playbackRate: 1,
                    },
                  },
                ],
              },
            },
          });
        }
      }
    },
  );
});

afterEach(async () => {
  await service.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('initial playback metadata', () => {
  it.each([false, true])(
    'hydrates an already-playing receiver with state-only startup=%s',
    async (partial) => {
      stateOnly = partial;
      service.connect({ identifier: discovered.deviceId, credentials: credentials.serialize() });
      await vi.waitFor(
        () => {
          expect(service.state.status).toBe('connected');
          expect(observed).toContainEqual(
            expect.objectContaining({
              title: 'Fixture Movie',
              duration: 600,
              elapsedTime: 30,
              playbackState: 1,
              appBundleIdentifier: 'fixture.app',
            }),
          );
        },
        { timeout: 500 },
      );
      expect(errors).toEqual([]);
    },
  );

  it('keeps an idle receiver connected without a spurious metadata error', async () => {
    replyError = 35;
    service.connect({ identifier: discovered.deviceId, credentials: credentials.serialize() });
    await vi.advanceTimersByTimeAsync(100);
    expect(service.state.status).toBe('connected');
    expect(observed).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('reports an unexpected metadata rejection without disconnecting the remote', async () => {
    replyError = 9;
    service.connect({ identifier: discovered.deviceId, credentials: credentials.serialize() });
    await vi.waitFor(
      () => {
        expect(errors).toContainEqual(expect.objectContaining({ errorCode: 9 }));
      },
      { timeout: 500 },
    );
    expect(service.state.status).toBe('connected');
  });
});

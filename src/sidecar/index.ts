// Node sidecar entrypoint: serves ATVService over line-delimited JSON on stdin/stdout for the
// Tauri host (src-tauri/src/backend.rs).
//
// Protocol: one JSON object per line. Requests are `{ id, method, params }` and are handled
// concurrently, so replies `{ id, result }` or `{ id, error }` can arrive in any order. Events
// are `{ event, data }`: `state` (ConnectionState), `now-playing`, and `error`. `connect` and
// `reconnect` reply at once and report progress as `state`. Logs go only to stderr. When stdin
// closes, requests that finish within a second are still answered, then the process exits.
import { Console } from 'node:console';
import { createInterface } from 'node:readline';
import ATVService from './atv_service';
import type { ATVKeyName } from '../shared/types';

// stdout belongs exclusively to the protocol, including logs from dependencies.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

const service = new ATVService();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
type RequestId = string | number;
interface Request {
  id: RequestId;
  method: string;
  params: Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestId(value: unknown): RequestId | null {
  if (!isObject(value)) return null;
  const id = value.id;
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)) ? id : null;
}

function parseRequest(value: unknown): Request {
  const id = requestId(value);
  if (id === null || !isObject(value) || typeof value.method !== 'string') {
    throw new Error('Expected an object with a string or number id and a method');
  }
  if (value.params !== undefined && !isObject(value.params)) {
    throw new Error('params must be an object');
  }
  return { id, method: value.method, params: value.params ?? {} };
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function dispatch({ method, params }: Request): Promise<unknown> {
  switch (method) {
    case 'scan':
      return service.scan();
    case 'startPair':
      await service.startPair(stringParam(params, 'deviceLabel'));
      return null;
    case 'finishPair':
      return service.finishPair(stringParam(params, 'pin'));
    // Both return at once; the connection's progress arrives as `state` events.
    case 'connect':
    case 'reconnect':
      service[method]({
        credentials: stringParam(params, 'credentials'),
        identifier: stringParam(params, 'identifier'),
      });
      return null;
    case 'disconnect':
      await service.disconnect();
      return null;
    case 'sendKey':
      // ATVService rejects unknown keys, including inherited names like 'toString'.
      await service.sendKey(stringParam(params, 'key') as ATVKeyName);
      return null;
    case 'seek': {
      const seconds = params.seconds;
      if (typeof seconds !== 'number') throw new Error('seconds must be a number');
      await service.seek(seconds);
      return null;
    }
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

for (const event of ['state', 'now-playing']) {
  service.on(event, (data: unknown = null) => send({ event, data }));
}
service.on('error', (error: Error) => send({ event: 'error', data: { message: error.message } }));

let stopping = false;
async function stop(id?: RequestId): Promise<void> {
  if (stopping) return;
  stopping = true;
  input.close();
  await service.destroy();
  if (id !== undefined) send({ id, result: null });
  // Existing service/library timers must not keep an orphaned sidecar alive.
  process.stdout.end(() => process.exit(0));
}

function errorReply(id: RequestId | null, error: unknown): unknown {
  return { id, error: { message: error instanceof Error ? error.message : String(error) } };
}

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error);
  process.exit(1);
});
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
// Survive stray library errors (e.g. an AppleTV socket error emitted with no listener); exiting
// would fail every request until the host relaunches us.
process.on('uncaughtException', (error) => console.error('Uncaught exception:', error));
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));

const inFlight = new Set<Promise<void>>();

async function respond(request: Request): Promise<void> {
  let reply: unknown;
  try {
    reply = { id: request.id, result: await dispatch(request) };
  } catch (error) {
    reply = errorReply(request.id, error);
  }
  // The host fails its pending requests on shutdown; stdout may already be closing.
  if (!stopping) send(reply);
}

async function main(): Promise<void> {
  send({ event: 'ready', data: { protocolVersion: 1, nodeVersion: process.versions.node } });
  // Requests run concurrently, so one hung library call cannot block the rest; replies carry
  // the request id. The host bounds each request with a timeout.
  for await (const line of input) {
    if (stopping) break;
    let value: unknown;
    let request: Request;
    try {
      value = JSON.parse(line);
      request = parseRequest(value);
    } catch (error) {
      send(errorReply(requestId(value), error));
      continue;
    }
    if (request.method === 'shutdown') {
      await stop(request.id);
      return;
    }
    const handled = respond(request);
    inFlight.add(handled);
    void handled.finally(() => inFlight.delete(handled));
  }
  // End of input: the host exited or crashed. Answer what was already received if that is
  // quick, but exit within a second regardless, so a hung request (or a hung cleanup) cannot
  // leave the sidecar orphaned; nobody remains to read a late reply.
  setTimeout(() => process.exit(0), 1000);
  await Promise.all(inFlight);
  await stop();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

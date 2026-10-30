// Runs the bundled sidecar as a child process and checks its stdin/stdout protocol end to end.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let temporary: string;
let entrypoint: string;
/** The sidecar with a stand-in library whose scan lasts exactly its 2 s window, offline. */
let slowScanEntrypoint: string;
/** The source files esbuild put into the real sidecar bundle. */
let bundledInputs: string[];

function bundle(outfile: string, plugins: Plugin[] = []) {
  return build({
    entryPoints: ['src/sidecar/index.ts'],
    nodePaths: [path.resolve('app/node_modules')],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    plugins,
    outfile,
    metafile: true,
  });
}

beforeAll(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), 'atv-sidecar-test-'));
  entrypoint = path.join(temporary, 'sidecar.mjs');
  slowScanEntrypoint = path.join(temporary, 'sidecar-slow-scan.mjs');
  // A real mDNS scan may fail fast (no network on CI), which would end a "slow" request early.
  const library = path.join(temporary, 'slow-scan-library.mjs');
  await writeFile(
    library,
    'export const scan = ({ timeout }) => new Promise((resolve) => setTimeout(() => resolve([]), timeout));\n',
  );
  const stubLibrary: Plugin = {
    name: 'slow-scan-library',
    setup(build) {
      build.onResolve({ filter: /^node-appletv-remote$/ }, () => ({ path: library }));
    },
  };
  const [real] = await Promise.all([bundle(entrypoint), bundle(slowScanEntrypoint, [stubLibrary])]);
  bundledInputs = Object.keys(real.metafile.inputs);
});

afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

interface Message {
  id?: string | number | null;
  result?: unknown;
  error?: { message: string };
  event?: string;
}

interface ExchangeOptions {
  /** The bundled sidecar to run; defaults to the one with the real library. */
  sidecar?: string;
  /** Node flags placed before the sidecar entrypoint, such as a preload module. */
  nodeArgs?: string[];
  /** Holds back the input until stderr contains every one of these strings. */
  waitForStderr?: string[];
  /** Keeps stdin open, as a live host does, until replies with these ids arrive. */
  holdInputFor?: Array<string | number>;
  timeout?: number;
}

async function exchange(
  input: string,
  {
    sidecar = entrypoint,
    nodeArgs = [],
    waitForStderr = [],
    holdInputFor = [],
    timeout = 3000,
  }: ExchangeOptions = {},
): Promise<Message[]> {
  const { promise, resolve, reject } = Promise.withResolvers<Message[]>();
  // Bound a stuck OS child; completion is driven by its close event, never a sleep.
  const child = spawn(process.execPath, [...nodeArgs, sidecar], {
    cwd: temporary,
    timeout,
    killSignal: 'SIGKILL',
  });
  let stdout = '';
  let stderr = '';
  let sent = false;
  function endWhenAnswered(): void {
    if (!sent || child.stdin.writableEnded) return;
    if (holdInputFor.every((id) => stdout.includes(`"id":${JSON.stringify(id)}`))) {
      child.stdin.end();
    }
  }
  function sendWhenReady(): void {
    if (sent || !waitForStderr.every((text) => stderr.includes(text))) return;
    sent = true;
    child.stdin.write(input);
    endWhenAnswered();
  }
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    endWhenAnswered();
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
    sendWhenReady();
  });
  child.on('error', reject);
  child.on('close', (code, signal) => {
    if (code !== 0) {
      reject(new Error(`Sidecar exited ${code ?? signal}: ${stderr}`));
      return;
    }
    try {
      resolve(
        stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Message),
      );
    } catch (error) {
      reject(error);
    }
  });
  sendWhenReady();
  return promise;
}

describe('sidecar protocol', () => {
  it('bundles the library itself, not the type declarations tsconfig maps it to', () => {
    // esbuild reads tsconfig paths too; bundling index.d.ts would ship a sidecar without it.
    expect(bundledInputs.some((input) => input.endsWith('node-appletv-remote/dist/index.js'))).toBe(
      true,
    );
  });

  it('recovers from malformed frames and correlates errors without accepting invalid requests', async () => {
    const messages = await exchange(
      [
        '{broken',
        'null',
        '{"id":true,"method":"shutdown"}',
        '{"id":"bad-params","method":"shutdown","params":[]}',
        '{"id":0,"method":"unknown"}',
        '{"id":"removed","method":"isConnected"}',
        '{"id":"check","method":"disconnect"}',
        '',
      ].join('\n'),
    );
    const responses = messages.filter((message) => Object.hasOwn(message, 'id'));
    expect(responses.map((message) => message.id)).toEqual([
      null,
      null,
      null,
      'bad-params',
      0,
      'removed',
      'check',
    ]);
    for (const response of responses.slice(0, -1)) {
      expect(response.error).toEqual({ message: expect.any(String) });
      expect(response).not.toHaveProperty('result');
    }
    expect(responses.at(-2)).toHaveProperty('error.message', 'Unknown method: isConnected');
    expect(responses.at(-1)).toEqual({ id: 'check', result: null });
  });

  it('flushes the shutdown response and does not execute buffered commands after shutdown', async () => {
    const messages = await exchange(
      ['{"id":"stop","method":"shutdown"}', '{"id":"ignored","method":"disconnect"}', ''].join(
        '\n',
      ),
    );
    expect(messages.filter((message) => Object.hasOwn(message, 'id'))).toEqual([
      { id: 'stop', result: null },
    ]);
    expect(messages.at(-1)).toEqual({ id: 'stop', result: null });
    expect(messages.filter((message) => message.event === 'state')).toEqual([
      { event: 'state', data: { status: 'idle' } },
    ]);
  });

  it('answers connect at once and reports its progress as state events', async () => {
    // The stand-in scan takes 2 s, so a reply that waited for the connect would miss the limit.
    const messages = await exchange(
      '{"id":"c","method":"connect","params":{"credentials":"x","identifier":"tv"}}\n',
      { sidecar: slowScanEntrypoint, holdInputFor: ['c'], timeout: 1900 },
    );
    expect(messages.filter((message) => Object.hasOwn(message, 'id'))).toEqual([
      { id: 'c', result: null },
    ]);
    expect(messages).toContainEqual({ event: 'state', data: { status: 'connecting' } });
  });

  it('serves power, which needs a connection', async () => {
    const messages = await exchange('{"id":"power","method":"power"}\n');
    expect(messages).toContainEqual({ id: 'power', error: { message: 'Not connected' } });
  });

  it('rejects prototype-property commands and processes a final CRLF frame before EOF', async () => {
    const messages = await exchange(
      '{"id":"key","method":"sendKey","params":{"key":"toString"}}\r\n' +
        '{"id":"disconnect","method":"disconnect"}\r\n' +
        '{"id":"final","method":"disconnect"}',
    );
    // Requests run concurrently, so replies are matched by id rather than order.
    const responses = new Map(
      messages.filter((message) => Object.hasOwn(message, 'id')).map((m) => [m.id, m]),
    );
    expect([...responses.keys()].sort()).toEqual(['disconnect', 'final', 'key']);
    expect(responses.get('key')).toHaveProperty('error.message', 'Unknown key: toString');
    expect(responses.get('disconnect')).toEqual({ id: 'disconnect', result: null });
    expect(responses.get('final')).toEqual({ id: 'final', result: null });
  });

  it(
    'answers a quick request while an earlier slow one is still running',
    { timeout: 10000 },
    async () => {
      // scan browses the network for its 2 s window; a seek it rejects must not queue behind it.
      const messages = await exchange(
        [
          '{"id":"slow","method":"scan"}',
          '{"id":"quick","method":"seek","params":{"seconds":-1}}',
          '',
        ].join('\n'),
        { sidecar: slowScanEntrypoint, holdInputFor: ['slow'], timeout: 8000 },
      );
      const responses = messages.filter((message) => Object.hasOwn(message, 'id'));
      expect(responses.map((message) => message.id)).toEqual(['quick', 'slow']);
      expect(responses[0]).toHaveProperty('error.message', 'Invalid position');
    },
  );

  it('exits soon after its input closes even while a request is still running', async () => {
    // A crashed host closes our stdin; nobody is left to read the scan's (2 s) reply.
    const messages = await exchange('{"id":"slow","method":"scan"}\n', {
      sidecar: slowScanEntrypoint,
      timeout: 1900,
    });
    expect(messages.filter((message) => Object.hasOwn(message, 'id'))).toEqual([]);
  });

  it('logs stray exceptions and rejections and keeps serving requests', async () => {
    const preload = path.join(temporary, 'stray-failures.mjs');
    // Fails outside any request once the sidecar is running (or after 1 s without its guards).
    await writeFile(
      preload,
      `const started = Date.now();
const timer = setInterval(() => {
  if (process.listenerCount('uncaughtException') === 0 && Date.now() - started < 1000) return;
  clearInterval(timer);
  void Promise.reject(new Error('stray rejection'));
  throw new Error('stray exception');
}, 10);
`,
    );
    const messages = await exchange('{"id":"after","method":"disconnect"}\n', {
      nodeArgs: ['--import', pathToFileURL(preload).href],
      waitForStderr: ['stray exception', 'stray rejection'],
    });
    expect(messages.filter((message) => Object.hasOwn(message, 'id'))).toEqual([
      { id: 'after', result: null },
    ]);
  });
});

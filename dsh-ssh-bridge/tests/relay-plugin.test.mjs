/**
 * The relay transport inside the plugin: a stand-in DSH web server, a real relay, and a
 * browser stand-in taking the exact path a phone takes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../lib/index.mjs';
import { createRelay } from '../lib/relay-server.mjs';
import { pair, request } from './helpers/relay-phone.mjs';
import { waitFor } from './helpers/ssh-server.mjs';

const HOST_TOKEN = 'host-token-0123456789abcdef';
const ACCESS_TOKEN = 'access-token-abcdef';

/**
 * Minimal Cordis context: services, effects, and a silent logger.
 * @returns {object} Fake context with `dispose()`.
 */
function makeContext({ webServer, connection } = {}) {
  const services = new Map();
  if (webServer !== undefined) services.set('webServer', webServer);
  if (connection !== undefined) services.set('connection', connection);
  const disposers = [];
  const logger = { info() {}, warn() {}, error() {}, debug() {} };

  const context = {
    webServer,
    provide(name, value) {
      services.set(name, value);
      return () => services.delete(name);
    },
    get(name) {
      return services.get(name);
    },
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    inject(_deps, callback) {
      callback(context);
    },
    logger: Object.assign(() => logger, logger),
    services,
    async dispose() {
      for (const dispose of disposers.reverse()) {
        try {
          await dispose();
        } catch {
          // Best effort in a test double.
        }
      }
    },
  };
  return context;
}

/**
 * Stand-in for the DSH web listener: serves an index and the plugin's routes.
 * @returns {Promise<object>} Running server plus the `webServer` service shape.
 */
async function makeWebServer() {
  const routes = new Map();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.invalid').pathname;
    if (pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('dsh-index');
      return;
    }
    const route = routes.get(pathname);
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    Promise.resolve(route.handler(req, res)).catch(() => res.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    server,
    webServer: {
      host: '127.0.0.1',
      get port() {
        return server.address().port;
      },
      protocol: 'http:',
      getOrigin: () => `http://127.0.0.1:${server.address().port}`,
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('the plugin publishes the DSH listener through the relay for a browser', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-plugin-'));
  const web = await makeWebServer();
  const relay = await createRelay({
    port: 0,
    bind: '127.0.0.1',
    hostToken: HOST_TOKEN,
    accessToken: ACCESS_TOKEN,
    certFile: path.join(dir, 'cert.pem'),
    keyFile: path.join(dir, 'key.pem'),
    hosts: ['127.0.0.1'],
  });

  const ctx = makeContext({
    webServer: web.webServer,
    connection: {
      admit: () => ({ peer: { id: 'peer-1' } }),
      authenticatedUrl: (url) => {
        const parsed = new URL(url);
        parsed.searchParams.set('token', 'DshLaunchToken');
        return parsed.href;
      },
    },
  });
  t.after(async () => {
    await ctx.dispose();
    await relay.close();
    await web.close();
  });

  await apply(ctx, {
    enabled: true,
    transport: 'relay',
    relay: {
      host: '127.0.0.1',
      port: relay.port,
      publicHost: '127.0.0.1',
      token: HOST_TOKEN,
      accessToken: ACCESS_TOKEN,
      fingerprint: relay.fingerprint,
      poolSize: 2,
      refreshMs: 150,
    },
    /* The fixed pairing page would contend for the port the real Desktop already holds. */
    pairing: { localPort: 0 },
    statusPage: true,
  });

  const service = ctx.get('sshBridge');
  assert.ok(service !== undefined, 'the plugin provided its service');

  await waitFor(() => service.status().mode === 'relay' && service.status().idle > 0, { timeoutMs: 15_000 });
  assert.ok(service.status().idle > 0, 'idle relay connections are held open for the phone');
  assert.notEqual(service.status().state, 'stopped');

  /* The owner reads the pairing link from the DSH status route directly. */
  const statusResponse = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: web.server.address().port, path: '/ssh-bridge/status' }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });

  assert.equal(statusResponse.mode, 'relay');
  assert.equal(statusResponse.pairing.mode, 'relay');
  assert.equal(statusResponse.pairing.url, `https://127.0.0.1:${relay.port}/`);
  assert.match(statusResponse.pairing.tokenUrl, new RegExp(`\\?rk=${ACCESS_TOKEN}&token=DshLaunchToken`));
  assert.equal(statusResponse.pairing.sshCommand, undefined, 'no SSH material in relay mode');

  /* The phone scans the QR (or taps the link) and lands on DSH. */
  const pairing = await pair({ port: relay.port, accessToken: ACCESS_TOKEN });
  assert.equal(pairing.status, 303);

  const index = await request({ port: relay.port, cookie: pairing.cookie });
  assert.equal(index.status, 200);
  assert.equal(index.body, 'dsh-index', 'the browser reached the DSH listener through the relay');
});

test('a relay with no host token refuses to start the transport and says why', async (t) => {
  const ctx = makeContext();
  t.after(() => ctx.dispose());

  await apply(ctx, {
    enabled: true,
    transport: 'relay',
    relay: { host: '127.0.0.1', port: 8443, token: '' },
    statusPage: false,
  });

  const service = ctx.get('sshBridge');
  assert.equal(service.status().state, 'stopped', 'nothing connected without a token');
});

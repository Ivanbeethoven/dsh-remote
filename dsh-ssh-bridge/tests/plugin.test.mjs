/**
 * Plugin-level integration: load the Cordis plugin against a stand-in web server and
 * reach its routes through the SSH forward, which is the path the phone takes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';

import { apply } from '../lib/index.mjs';
import { startSshServer, testHostKey, waitFor } from './helpers/ssh-server.mjs';

/**
 * A minimal Cordis context: services, effects, and a no-op logger.
 * @param {object} options - Injected services.
 * @returns {object} Fake context with a `dispose()`.
 */
function makeContext({ webServer, connection }) {
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
          // Disposal is best-effort in the test double.
        }
      }
    },
  };
  return context;
}

/**
 * Stand-in for the DSH web listener, with the plugin's routes wired into it.
 * @returns {Promise<object>} The running server plus the `webServer` service shape.
 */
async function makeWebServer() {
  const routes = new Map();
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://dsh.invalid').pathname;
    const route = routes.get(pathname);
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    Promise.resolve(route.handler(request, response)).catch(() => response.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    server,
    port: server.address().port,
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

/**
 * Create a temp client key for the SSH server.
 * @returns {{ keyPath: string, knownHostsPath: string }} Paths.
 */
function clientFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-bridge-plugin-'));
  const keyPath = path.join(dir, 'id_ed25519');
  fs.writeFileSync(keyPath, ssh2.utils.generateKeyPairSync('ed25519').private, { mode: 0o600 });
  return { keyPath, knownHostsPath: path.join(dir, 'known_hosts') };
}

/**
 * Start the bridge against a test SSH server.
 * @returns {Promise<object>} Everything the assertions need, plus cleanup.
 */
async function startBridge({ connection } = {}) {
  const { keyPath, knownHostsPath } = clientFixture();
  const ssh = await startSshServer({ hostKey: testHostKey().private });
  const web = await makeWebServer();
  const ctx = makeContext({ webServer: web.webServer, connection });

  await apply(ctx, {
    enabled: true,
    ssh: {
      host: '127.0.0.1',
      port: ssh.port,
      username: 'dsh',
      authMethod: 'privateKey',
      privateKeyPath: keyPath,
      knownHostsPath,
      hostKeyPolicy: 'accept-new',
    },
    forward: { bindAddress: '127.0.0.1', port: 0 },
    reconnect: { enabled: false },
    pairing: { phonePort: 9111, qr: false, localPort: 0 },
  });

  const service = ctx.get('sshBridge');
  await waitFor(() => service.status().state === 'forwarding', { timeoutMs: 15_000 });

  return {
    ctx,
    service,
    ssh,
    remotePort: service.status().forward.remotePort,
    async close() {
      await ctx.dispose();
      await web.close();
      await ssh.close();
    },
  };
}

/**
 * GET a path from the forwarded port.
 * @returns {Promise<{ status: number, headers: object, body: string }>} Response.
 */
function get(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method: options.method ?? 'GET', headers: options.headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('apply publishes the service and forwards the status routes', async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.close());

  assert.equal(bridge.service.status().state, 'forwarding', 'the bridge reached the forwarding state');

  const status = await get(bridge.remotePort, '/ssh-bridge/status');
  assert.equal(status.status, 200);
  assert.match(status.headers['content-type'], /application\/json/);
  assert.equal(status.headers['cache-control'], 'no-store');

  const body = JSON.parse(status.body);
  assert.equal(body.state, 'forwarding');
  assert.equal(body.ssh.username, 'dsh');
  assert.equal(body.forward.remotePort, bridge.remotePort);
  assert.equal(body.forward.target.port, bridge.webPort ?? body.forward.target.port);
  assert.equal(body.pairing.url, 'http://127.0.0.1:9111/');
  assert.equal(body.pairing.tokenUrl, null, 'no token without a Connection service');
  assert.match(body.pairing.sshCommand, /-L 9111:127\.0\.0\.1:\d+/);
  assert.match(body.pairing.sshConfig, /LocalForward 9111/);
});

test('the status page renders for a paired browser', async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.close());

  const page = await get(bridge.remotePort, '/ssh-bridge');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, /DSH bridge/);
  assert.match(page.body, /ssh -N/);
  assert.match(page.body, /http:\/\/127\.0\.0\.1:9111\//);
});

test('a Connection service supplies the authenticated pairing URL', async (t) => {
  const bridge = await startBridge({
    connection: {
      admit: () => ({ peer: { id: 'peer-1' } }),
      authenticatedUrl: (url) => `${url}?token=launch-token`,
    },
  });
  t.after(() => bridge.close());

  const status = JSON.parse((await get(bridge.remotePort, '/ssh-bridge/status')).body);
  assert.equal(status.pairing.tokenUrl, 'http://127.0.0.1:9111/?token=launch-token');
});

test('an unauthenticated browser is refused', async (t) => {
  const bridge = await startBridge({ connection: { admit: () => ({ rejection: 403 }) } });
  t.after(() => bridge.close());

  const status = await get(bridge.remotePort, '/ssh-bridge/status');
  assert.equal(status.status, 403);
  assert.equal(status.body, 'forbidden');

  const page = await get(bridge.remotePort, '/ssh-bridge');
  assert.equal(page.status, 403);
});

test('reconnect only accepts a same-site POST', async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.close());

  const viaGet = await get(bridge.remotePort, '/ssh-bridge/reconnect');
  assert.equal(viaGet.status, 405);
  assert.equal(viaGet.headers.allow, 'POST');

  const crossSite = await get(bridge.remotePort, '/ssh-bridge/reconnect', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);

  const ok = await get(bridge.remotePort, '/ssh-bridge/reconnect', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(ok.status, 202);
  assert.deepEqual(JSON.parse(ok.body), { restarting: true });
});

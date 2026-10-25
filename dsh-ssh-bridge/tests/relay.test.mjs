/**
 * Relay tests: a real TLS relay, a real pool from the plugin transport, and a browser
 * stand-in sending raw HTTP — the same three parties that exist in production.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { RelayClient } from '../lib/relay-client.mjs';
import { createRelay } from '../lib/relay-server.mjs';
import { pair, request } from './helpers/relay-phone.mjs';
import { waitFor } from './helpers/ssh-server.mjs';

const HOST_TOKEN = 'host-token-0123456789abcdef';
const ACCESS_TOKEN = 'access-token-abcdef';

/**
 * Start an HTTP server that stands in for the DSH web listener.
 * @returns {Promise<{ port: number, close: () => Promise<void> }>} Listener handle.
 */
async function startTarget() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
    res.end(`relay-ok:${req.url}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Certificate paths in a fresh temp directory.
 * @returns {{ certFile: string, keyFile: string }} Paths.
 */
function certificateFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-'));
  return { certFile: path.join(dir, 'cert.pem'), keyFile: path.join(dir, 'key.pem') };
}

/**
 * Start a relay plus a client pool wired to the target.
 * @returns {Promise<object>} Handle with cleanup.
 */
async function startRelayAndClient({ poolSize = 2 } = {}) {
  const target = await startTarget();
  const { certFile, keyFile } = certificateFiles();
  const relay = await createRelay({
    port: 0,
    bind: '127.0.0.1',
    hostToken: HOST_TOKEN,
    accessToken: ACCESS_TOKEN,
    certFile,
    keyFile,
    hosts: ['127.0.0.1'],
    poolSize: 8,
    /* Short enough that the "no free connection" path is testable, long enough that a
       refill can rescue a queued request. */
    waitMs: 600,
  });

  const client = new RelayClient({
    config: {
      relay: {
        host: '127.0.0.1',
        port: relay.port,
        publicHost: '127.0.0.1',
        publicPort: relay.port,
        hostId: 'default',
        token: HOST_TOKEN,
        accessToken: ACCESS_TOKEN,
        fingerprint: relay.fingerprint,
        poolSize,
        refreshMs: 150,
        idleTtlMs: 30_000,
        timeoutMs: 5_000,
        insecure: false,
      },
    },
    resolveTarget: () => ({ host: '127.0.0.1', port: target.port }),
  });

  return {
    relay,
    client,
    target,
    async close() {
      client.stop();
      await relay.close();
      await target.close();
    },
  };
}

test('a paired browser reaches the DSH listener through the relay', async (t) => {
  const rig = await startRelayAndClient();
  t.after(() => rig.close());

  rig.client.start();
  await waitFor(() => rig.client.status().idle > 0, { timeoutMs: 10_000 });

  const pairing = await pair({ port: rig.relay.port, accessToken: ACCESS_TOKEN });
  assert.equal(pairing.status, 303, 'the access key is exchanged for a cookie');
  assert.equal(pairing.location, '/', 'the access key is stripped from the URL');

  const index = await request({ port: rig.relay.port, cookie: pairing.cookie });
  assert.equal(index.status, 200);
  assert.equal(index.body, 'relay-ok:/', 'the request reached the local listener byte for byte');

  const deep = await request({ port: rig.relay.port, path: '/api/remote.mux?x=1', cookie: pairing.cookie });
  assert.equal(deep.body, 'relay-ok:/api/remote.mux?x=1');
});

test('the access key can travel alongside the DSH launch token', async (t) => {
  const rig = await startRelayAndClient();
  t.after(() => rig.close());

  rig.client.start();
  await waitFor(() => rig.client.status().idle > 0, { timeoutMs: 10_000 });

  const pairing = await pair({ port: rig.relay.port, accessToken: ACCESS_TOKEN, extraQuery: 'token=launch-token' });
  assert.equal(pairing.location, '/?token=launch-token', 'the DSH token survives the exchange');
});

test('an unpaired browser sees the login page, not DSH', async (t) => {
  const rig = await startRelayAndClient();
  t.after(() => rig.close());

  rig.client.start();
  await waitFor(() => rig.client.status().idle > 0, { timeoutMs: 10_000 });

  const page = await request({ port: rig.relay.port });
  assert.equal(page.status, 200);
  assert.match(page.body, /DSH relay/);
  assert.match(page.body, /name="rk"/);
});

test('the root gate drops the access key but deeper paths are proxied with it', async (t) => {
  const rig = await startRelayAndClient();
  t.after(() => rig.close());

  rig.client.start();
  await waitFor(() => rig.client.status().idle > 0, { timeoutMs: 10_000 });

  const root = await request({ port: rig.relay.port, path: `/?rk=${ACCESS_TOKEN}&token=t` });
  assert.equal(root.status, 303);
  assert.equal(root.headers.location, '/?token=t', 'the root gate keeps the key out of history');

  /* An installed app relies on this: one hop, no cookie required, and the plugin receives
     the key so it can authenticate the request itself. */
  const deep = await request({ port: rig.relay.port, path: `/ssh-bridge?rk=${ACCESS_TOKEN}&go=1` });
  assert.equal(deep.status, 200, 'a deep request with a valid key is proxied directly');
  assert.equal(deep.body, `relay-ok:/ssh-bridge?rk=${ACCESS_TOKEN}&go=1`, 'the host receives the key intact');

  /* A wrong key is still refused before it reaches the host. */
  const wrong = await request({ port: rig.relay.port, path: '/ssh-bridge?rk=nope' });
  assert.equal(wrong.status, 403);
});

test('a wrong access key is refused', async (t) => {
  const rig = await startRelayAndClient();
  t.after(() => rig.close());

  rig.client.start();
  await waitFor(() => rig.client.status().idle > 0, { timeoutMs: 10_000 });

  const refused = await request({ port: rig.relay.port, path: '/?rk=not-the-key' });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers['set-cookie'], undefined);
});

test('the health endpoint reports the pool without authentication', async (t) => {
  const rig = await startRelayAndClient();
  t.after(() => rig.close());

  rig.client.start();
  await waitFor(() => rig.client.status().idle > 0, { timeoutMs: 10_000 });

  const health = await request({ port: rig.relay.port, path: '/__relay/health' });
  assert.equal(health.status, 200);
  const body = JSON.parse(health.body);
  assert.equal(body.ok, true);
  assert.equal(body.host, 'default');
  assert.ok(body.idle > 0);
});

test('a browser is told DSH is away when the pool stays empty', async (t) => {
  const rig = await startRelayAndClient();
  t.after(() => rig.close());

  rig.client.start();
  await waitFor(() => rig.client.status().idle > 0, { timeoutMs: 10_000 });
  const pairing = await pair({ port: rig.relay.port, accessToken: ACCESS_TOKEN });

  rig.client.stop();
  await waitFor(() => rig.relay.status().idle === 0, { timeoutMs: 10_000 });

  const away = await request({ port: rig.relay.port, cookie: pairing.cookie });
  assert.equal(away.status, 503);
  assert.match(away.body, /No free relay connection/);
});

test('a queued browser is served as soon as a connection frees up', async (t) => {
  const rig = await startRelayAndClient({ poolSize: 1 });
  t.after(() => rig.close());

  rig.client.start();
  await waitFor(() => rig.client.status().idle > 0, { timeoutMs: 10_000 });
  const pairing = await pair({ port: rig.relay.port, accessToken: ACCESS_TOKEN });

  /* Drain the pool, then issue a request: with no idle connection it has to wait rather
     than fail, because a browser opens several connections at once for one page. */
  rig.client.stop();
  await waitFor(() => rig.relay.status().idle === 0, { timeoutMs: 10_000 });

  const pending = request({ port: rig.relay.port, path: '/queued', cookie: pairing.cookie });
  await new Promise((resolve) => setTimeout(resolve, 120));

  rig.client.start();
  const served = await pending;
  assert.equal(served.status, 200, 'the queued request was bridged instead of being refused');
  assert.equal(served.body, 'relay-ok:/queued');
});

test('a wrong host token never joins the pool', async (t) => {
  const target = await startTarget();
  const { certFile, keyFile } = certificateFiles();
  const relay = await createRelay({
    port: 0,
    bind: '127.0.0.1',
    hostToken: HOST_TOKEN,
    accessToken: ACCESS_TOKEN,
    certFile,
    keyFile,
    hosts: ['127.0.0.1'],
  });

  const client = new RelayClient({
    config: {
      relay: {
        host: '127.0.0.1',
        port: relay.port,
        publicHost: '127.0.0.1',
        publicPort: relay.port,
        hostId: 'default',
        token: 'wrong-token-0123456789',
        accessToken: ACCESS_TOKEN,
        fingerprint: relay.fingerprint,
        poolSize: 1,
        refreshMs: 150,
        idleTtlMs: 30_000,
        timeoutMs: 5_000,
        insecure: false,
      },
    },
    resolveTarget: () => ({ host: '127.0.0.1', port: target.port }),
  });

  t.after(async () => {
    client.stop();
    await relay.close();
    await target.close();
  });

  client.start();
  await waitFor(() => (client.status().lastError ?? '').includes('unauthorized'), { timeoutMs: 10_000 });
  assert.equal(relay.status().idle, 0);
});

test('a pinned certificate fingerprint rejects an impostor relay', async (t) => {
  const target = await startTarget();
  const first = certificateFiles();
  const relay = await createRelay({
    port: 0,
    bind: '127.0.0.1',
    hostToken: HOST_TOKEN,
    accessToken: ACCESS_TOKEN,
    certFile: first.certFile,
    keyFile: first.keyFile,
    hosts: ['127.0.0.1'],
  });

  const client = new RelayClient({
    config: {
      relay: {
        host: '127.0.0.1',
        port: relay.port,
        publicHost: '127.0.0.1',
        publicPort: relay.port,
        hostId: 'default',
        token: HOST_TOKEN,
        accessToken: ACCESS_TOKEN,
        /* A fingerprint from some other certificate. */
        fingerprint: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
        poolSize: 1,
        refreshMs: 150,
        idleTtlMs: 30_000,
        timeoutMs: 5_000,
        insecure: false,
      },
    },
    resolveTarget: () => ({ host: '127.0.0.1', port: target.port }),
  });

  t.after(async () => {
    client.stop();
    await relay.close();
    await target.close();
  });

  client.start();
  await waitFor(() => (client.status().lastError ?? '').includes('fingerprint mismatch'), { timeoutMs: 10_000 });
  assert.equal(relay.status().idle, 0);
});

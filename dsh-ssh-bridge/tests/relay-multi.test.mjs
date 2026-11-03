/**
 * Multi-host relay tests: one public port carrying two DSH machines, selected by the
 * access key a browser presents — and the same flow over plain HTTP.
 *
 * These cover the two properties the relay gained after the first release:
 * - tenancy: `hostId`/`hostToken`/`accessToken` per host, with the access key as the
 *   routing key, so a browser lands on the machine its key belongs to;
 * - transport: `secure: false` serves the identical protocol on a plain socket.
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

const HOST_A = { hostId: 'alpha', hostToken: 'host-token-alpha-0123456789', accessToken: 'access-alpha-abc' };
const HOST_B = { hostId: 'beta', hostToken: 'host-token-beta-0123456789', accessToken: 'access-beta-xyz' };

/**
 * Start an HTTP server that answers with its own name, standing in for a DSH listener.
 * @param {string} name - Body prefix identifying the host.
 * @returns {Promise<{ port: number, close: () => Promise<void> }>} Listener handle.
 */
async function startNamedTarget(name) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
    res.end(`${name}:${req.url}`);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-multi-'));
  return { certFile: path.join(dir, 'cert.pem'), keyFile: path.join(dir, 'key.pem') };
}

/**
 * Build a pool client for one host entry.
 * @param {object} options - Wiring inputs.
 * @param {object} options.host - Host entry.
 * @param {number} options.port - Relay port.
 * @param {number} options.targetPort - Local DSH stand-in port.
 * @param {string} [options.protocol] - `http` for a plain relay.
 * @param {number} [options.poolSize] - Pool size.
 * @returns {RelayClient} Started client.
 */
function makeClient({ host, port, targetPort, protocol = 'https', poolSize = 4 }) {
  const client = new RelayClient({
    config: {
      relay: {
        host: '127.0.0.1',
        port,
        protocol,
        publicHost: '127.0.0.1',
        publicPort: port,
        hostId: host.hostId,
        token: host.hostToken,
        accessToken: host.accessToken,
        poolSize,
        refreshMs: 150,
        idleTtlMs: 30_000,
        timeoutMs: 5_000,
        insecure: true,
      },
    },
    resolveTarget: () => ({ host: '127.0.0.1', port: targetPort }),
  });
  client.start();
  return client;
}

test('one port serves two hosts, selected by access key', async (t) => {
  const alpha = await startNamedTarget('alpha');
  const beta = await startNamedTarget('beta');
  const { certFile, keyFile } = certificateFiles();

  const relay = await createRelay({
    port: 0,
    bind: '127.0.0.1',
    hosts: [HOST_A, HOST_B],
    certFile,
    keyFile,
    certHosts: ['127.0.0.1'],
    poolSize: 4,
    waitMs: 600,
  });

  const clientA = makeClient({ host: HOST_A, port: relay.port, targetPort: alpha.port });
  const clientB = makeClient({ host: HOST_B, port: relay.port, targetPort: beta.port });

  t.after(async () => {
    clientA.stop();
    clientB.stop();
    await relay.close();
    await alpha.close();
    await beta.close();
  });

  await waitFor(() => clientA.status().idle > 0 && clientB.status().idle > 0, { timeoutMs: 10_000 });

  const health = JSON.parse((await request({ port: relay.port, path: '/__relay/health' })).body);
  assert.equal(health.hosts.length, 2);
  assert.deepEqual(health.hosts.map((host) => host.hostId).sort(), ['alpha', 'beta']);
  assert.ok(health.hosts.every((host) => host.idle > 0), 'both hosts hold idle connections');

  const pairedA = await pair({ port: relay.port, accessToken: HOST_A.accessToken });
  const pairedB = await pair({ port: relay.port, accessToken: HOST_B.accessToken });

  const viaA = await request({ port: relay.port, cookie: pairedA.cookie, path: '/one' });
  assert.equal(viaA.status, 200);
  assert.equal(viaA.body, 'alpha:/one');

  const viaB = await request({ port: relay.port, cookie: pairedB.cookie, path: '/two' });
  assert.equal(viaB.status, 200);
  assert.equal(viaB.body, 'beta:/two');

  /* A key that belongs to no host must not fall through to whichever host is closest. */
  const unknown = await request({ port: relay.port, path: '/?rk=not-a-real-key' });
  assert.equal(unknown.status, 403);
});

test('a shared access key offers a picker, then remembers the choice', async (t) => {
  const alpha = await startNamedTarget('alpha');
  const beta = await startNamedTarget('beta');
  const { certFile, keyFile } = certificateFiles();
  const shared = 'shared-access-key-abc';

  const relay = await createRelay({
    port: 0,
    bind: '127.0.0.1',
    hosts: [
      { ...HOST_A, accessToken: shared },
      { ...HOST_B, accessToken: shared },
    ],
    certFile,
    keyFile,
    certHosts: ['127.0.0.1'],
    poolSize: 4,
    waitMs: 600,
  });

  const clientA = makeClient({ host: { ...HOST_A, accessToken: shared }, port: relay.port, targetPort: alpha.port });
  const clientB = makeClient({ host: { ...HOST_B, accessToken: shared }, port: relay.port, targetPort: beta.port });

  t.after(async () => {
    clientA.stop();
    clientB.stop();
    await relay.close();
    await alpha.close();
    await beta.close();
  });

  await waitFor(() => clientA.status().idle > 0 && clientB.status().idle > 0, { timeoutMs: 10_000 });

  const paired = await pair({ port: relay.port, accessToken: shared });
  assert.equal(paired.status, 303);

  /* One key, no machine chosen: the browser gets a choice instead of an arbitrary host. */
  const picker = await request({ port: relay.port, cookie: paired.cookie, path: '/' });
  assert.equal(picker.status, 200);
  assert.match(picker.body, /Choose a machine/);
  assert.match(picker.body, /alpha/);
  assert.match(picker.body, /beta/);

  const choose = await request({ port: relay.port, cookie: paired.cookie, path: '/?h=beta' });
  assert.equal(choose.status, 303);
  assert.match(choose.headers['set-cookie'], /dsh_host=beta/);

  const both = `${paired.cookie}; dsh_host=beta`;
  const page = await request({ port: relay.port, cookie: both, path: '/' });
  assert.equal(page.status, 200);
  assert.equal(page.body, 'beta:/', 'the choice routes the session to that machine');

  const other = await request({ port: relay.port, cookie: `${paired.cookie}; dsh_host=alpha`, path: '/x' });
  assert.equal(other.body, 'alpha:/x');
});

test('a plain relay serves the same flow, with a non-Secure cookie', async (t) => {
  const target = await startNamedTarget('plain');
  const relay = await createRelay({
    port: 0,
    bind: '127.0.0.1',
    secure: false,
    hostToken: HOST_A.hostToken,
    accessToken: HOST_A.accessToken,
    poolSize: 4,
    waitMs: 600,
  });

  const client = makeClient({
    host: { ...HOST_A, hostId: 'default' },
    port: relay.port,
    targetPort: target.port,
    protocol: 'http',
  });

  t.after(async () => {
    client.stop();
    await relay.close();
    await target.close();
  });

  await waitFor(() => client.status().idle > 0, { timeoutMs: 10_000 });

  const paired = await pair({ port: relay.port, accessToken: HOST_A.accessToken, secure: false });
  assert.match(paired.cookie, /^dsh_relay=/);
  assert.equal(paired.status, 303);

  /* A `Secure` cookie would be dropped by every browser over http, producing a login loop. */
  const raw = await request({ port: relay.port, path: `/?rk=${HOST_A.accessToken}`, secure: false });
  const setCookie = raw.headers['set-cookie'];
  assert.ok(setCookie !== undefined, 'pairing sets a cookie');
  assert.doesNotMatch(setCookie, /Secure/i);

  const page = await request({ port: relay.port, cookie: paired.cookie, path: '/', secure: false });
  assert.equal(page.status, 200);
  assert.equal(page.body, 'plain:/');
});

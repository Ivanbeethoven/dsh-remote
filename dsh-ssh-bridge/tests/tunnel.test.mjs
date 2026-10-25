/**
 * End-to-end transport tests: a real SSH server, a real remote forward, and HTTP
 * bytes travelling from the forwarded port to a local listener through the tunnel.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';

import { startSshServer, testHostKey, waitFor } from './helpers/ssh-server.mjs';
import { SshTunnel } from '../lib/tunnel.mjs';
import { resolveConfig } from '../lib/index.mjs';

/**
 * Start an HTTP server that answers with a fixed body.
 * @returns {Promise<{ port: number, close: () => Promise<void> }>} Listener handle.
 */
async function startTarget(body = 'dsh-ok') {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`${body}:${request.url}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * GET a path over the forwarded port.
 * @returns {Promise<{ status: number, body: string }>} Response.
 */
function httpGet(port, pathname = '/') {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 5000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('request timed out')));
  });
}

/**
 * Build a temp directory holding a client key.
 * @returns {{ dir: string, keyPath: string, knownHostsPath: string }} Paths.
 */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-bridge-test-'));
  const keyPath = path.join(dir, 'id_ed25519');
  const pair = ssh2.utils.generateKeyPairSync('ed25519');
  fs.writeFileSync(keyPath, pair.private, { mode: 0o600 });
  return { dir, keyPath, knownHostsPath: path.join(dir, 'known_hosts') };
}

test('publishes a local listener through a remote forward', async (t) => {
  const { keyPath, knownHostsPath } = fixture();
  const hostKey = testHostKey();
  const ssh = await startSshServer({ hostKey: hostKey.private });
  const target = await startTarget();

  const tunnel = new SshTunnel({
    config: resolveConfig({
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
    }),
    resolveTarget: () => ({ host: '127.0.0.1', port: target.port }),
  });

  t.after(async () => {
    tunnel.stop();
    await target.close();
    await ssh.close();
  });

  tunnel.start();
  await waitFor(() => tunnel.state === 'forwarding', { timeoutMs: 15_000 });

  const status = tunnel.status();
  assert.equal(status.state, 'forwarding');
  assert.equal(status.forward.target.port, target.port);
  assert.ok(status.forward.remotePort > 0, 'the server reported the published port');

  const response = await httpGet(status.forward.remotePort, '/hello');
  assert.equal(response.status, 200);
  assert.equal(response.body, 'dsh-ok:/hello', 'HTTP travelled through the SSH channel');

  assert.equal(ssh.forwards.length, 1, 'exactly one forward was requested');
  assert.ok(ssh.forwards[0].connections >= 1, 'the server opened a forwarded-tcpip channel');
  assert.equal(status.authMethod, 'privateKey');

  const knownHosts = fs.readFileSync(knownHostsPath, 'utf8');
  assert.match(knownHosts, new RegExp(`^\\[127\\.0\\.0\\.1\\]:${ssh.port} ssh-ed25519 `, 'm'));
});

test('refuses a host key that is not in known_hosts under the strict policy', async (t) => {
  const { keyPath, knownHostsPath } = fixture();
  const ssh = await startSshServer();

  const tunnel = new SshTunnel({
    config: resolveConfig({
      ssh: {
        host: '127.0.0.1',
        port: ssh.port,
        username: 'dsh',
        authMethod: 'privateKey',
        privateKeyPath: keyPath,
        knownHostsPath,
        hostKeyPolicy: 'strict',
      },
      forward: { bindAddress: '127.0.0.1', port: 0 },
      reconnect: { enabled: false },
    }),
    resolveTarget: () => ({ host: '127.0.0.1', port: 9 }),
  });

  t.after(async () => {
    tunnel.stop();
    await ssh.close();
  });

  tunnel.start();
  await waitFor(() => tunnel.state === 'failed', { timeoutMs: 15_000 });
  assert.match(tunnel.status().lastError ?? '', /no known_hosts entry/);
});

test('refuses a changed host key', async (t) => {
  const { keyPath, knownHostsPath } = fixture();
  const ssh = await startSshServer();
  const impostor = testHostKey();
  fs.writeFileSync(
    knownHostsPath,
    `[127.0.0.1]:${ssh.port} ssh-ed25519 ${impostor.public.split(' ')[1]}\n`,
  );

  const tunnel = new SshTunnel({
    config: resolveConfig({
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
    }),
    resolveTarget: () => ({ host: '127.0.0.1', port: 9 }),
  });

  t.after(async () => {
    tunnel.stop();
    await ssh.close();
  });

  tunnel.start();
  await waitFor(() => tunnel.state === 'failed', { timeoutMs: 15_000 });
  assert.match(tunnel.status().lastError ?? '', /does not match/);
});

test('reconnects and re-establishes the forward after the server drops', async (t) => {
  const { keyPath, knownHostsPath } = fixture();
  const hostKey = testHostKey();
  const target = await startTarget('reconnected');

  let ssh = await startSshServer({ hostKey: hostKey.private });
  const sshPort = ssh.port;

  const tunnel = new SshTunnel({
    config: resolveConfig({
      ssh: {
        host: '127.0.0.1',
        port: sshPort,
        username: 'dsh',
        authMethod: 'privateKey',
        privateKeyPath: keyPath,
        knownHostsPath,
        hostKeyPolicy: 'accept-new',
      },
      forward: { bindAddress: '127.0.0.1', port: 0 },
      reconnect: { enabled: true, minDelayMs: 100, maxDelayMs: 300, factor: 1.5 },
    }),
    resolveTarget: () => ({ host: '127.0.0.1', port: target.port }),
  });

  t.after(async () => {
    tunnel.stop();
    await target.close();
    await ssh.close().catch(() => {});
  });

  tunnel.start();
  await waitFor(() => tunnel.state === 'forwarding', { timeoutMs: 15_000 });

  await ssh.close();
  await waitFor(() => tunnel.state !== 'forwarding', { timeoutMs: 15_000 });

  ssh = await startSshServer({ hostKey: hostKey.private, port: sshPort });
  await waitFor(() => tunnel.state === 'forwarding', { timeoutMs: 20_000 });

  const port = tunnel.status().forward.remotePort;
  const response = await httpGet(port, '/again');
  assert.equal(response.body, 'reconnected:/again');
});

test('a stopped tunnel stays down and closes its channels', async (t) => {
  const { keyPath, knownHostsPath } = fixture();
  const ssh = await startSshServer();
  const target = await startTarget();

  const tunnel = new SshTunnel({
    config: resolveConfig({
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
      reconnect: { enabled: true, minDelayMs: 100, maxDelayMs: 200 },
    }),
    resolveTarget: () => ({ host: '127.0.0.1', port: target.port }),
  });

  t.after(async () => {
    tunnel.stop();
    await target.close();
    await ssh.close();
  });

  tunnel.start();
  await waitFor(() => tunnel.state === 'forwarding', { timeoutMs: 15_000 });
  tunnel.stop();

  assert.equal(tunnel.state, 'stopped');
  assert.equal(tunnel.status().stats.openChannels, 0);

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(tunnel.state, 'stopped', 'a stopped tunnel does not reconnect');
});

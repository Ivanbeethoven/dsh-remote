/**
 * Configuration resolution and phone pairing material.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { Config, resolveConfig } from '../lib/index.mjs';
import { buildPairing, describePairing } from '../lib/pairing.mjs';

test('defaults fill in every field the transport reads', () => {
  const resolved = resolveConfig({});

  assert.equal(resolved.enabled, true);
  assert.equal(resolved.ssh.port, 22);
  assert.equal(resolved.ssh.username, 'dsh');
  assert.equal(resolved.ssh.authMethod, 'auto');
  assert.equal(resolved.ssh.hostKeyPolicy, 'accept-new');
  assert.equal(resolved.ssh.knownHostsPath, path.join(os.homedir(), '.ssh', 'known_hosts'));
  assert.equal(resolved.forward.bindAddress, '127.0.0.1');
  assert.equal(resolved.forward.port, 9100);
  assert.equal(resolved.reconnect.enabled, true);
  assert.equal(resolved.pairing.phonePort, 9100, 'the phone reuses the published port by default');
});

test('an explicit phone port is preserved and ~ is expanded', () => {
  const resolved = resolveConfig({
    ssh: { host: ' relay.example.com ', privateKeyPath: '~/.ssh/bridge', knownHostsPath: '~/kh' },
    forward: { port: 9200 },
    pairing: { phonePort: 9200 },
  });

  assert.equal(resolved.ssh.host, 'relay.example.com', 'the host is trimmed');
  assert.equal(resolved.ssh.privateKeyPath, path.join(os.homedir(), '.ssh', 'bridge'));
  assert.equal(resolved.ssh.knownHostsPath, path.join(os.homedir(), 'kh'));
  assert.equal(resolved.pairing.phonePort, 9200);
});

test('unknown enum values fall back instead of propagating', () => {
  const resolved = resolveConfig({ ssh: { authMethod: 'kerberos', hostKeyPolicy: 'yolo' } });
  assert.equal(resolved.ssh.authMethod, 'auto');
  assert.equal(resolved.ssh.hostKeyPolicy, 'accept-new');
});

test('the exported schema validates and applies the documented defaults', () => {
  const parsed = Config({});
  assert.equal(parsed.forward.port, 9100);
  assert.equal(parsed.ssh.hostKeyPolicy, 'accept-new');
  assert.equal(parsed.ssh.host, '');

  assert.throws(() => Config({ ssh: { hostKeyPolicy: 'yolo' } }), /hostKeyPolicy/);
  assert.throws(() => Config({ forward: { port: 70000 } }), /port/);
});

test('the schema accepts a complete configuration', () => {
  const parsed = Config({
    enabled: true,
    ssh: { host: 'relay.example.com', port: 2222, username: 'dsh', authMethod: 'agent' },
    forward: { bindAddress: '127.0.0.1', port: 9100 },
    reconnect: { enabled: true, minDelayMs: 1000, maxDelayMs: 30000, factor: 2 },
    pairing: { phonePort: 9100, qr: true },
    statusPage: true,
  });
  assert.equal(parsed.ssh.port, 2222);
  assert.equal(parsed.ssh.authMethod, 'agent');
});

test('pairing builds a phone command and a token URL', async () => {
  const pairing = await buildPairing({
    ssh: { host: 'relay.example.com', port: 22, username: 'dsh' },
    forward: { bindAddress: '127.0.0.1', remotePort: 9100 },
    phonePort: 9100,
    authenticatedUrl: (url) => `${url}?token=abc123`,
    qr: false,
  });

  assert.equal(pairing.url, 'http://127.0.0.1:9100/');
  assert.equal(pairing.tokenUrl, 'http://127.0.0.1:9100/?token=abc123');
  assert.equal(
    pairing.sshCommand,
    'ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 9100:127.0.0.1:9100 dsh@relay.example.com',
  );
  assert.match(pairing.sshConfig, /LocalForward 9100 127\.0\.0\.1:9100/);
  assert.match(pairing.sshConfig, /User dsh/);
  assert.equal(pairing.qrDataUrl, undefined, 'QR is skipped when disabled');
});

test('pairing spells out a non-default SSH port', async () => {
  const pairing = await buildPairing({
    ssh: { host: 'relay.example.com', port: 2222, username: 'bridge' },
    forward: { bindAddress: '127.0.0.1', remotePort: 9100 },
    phonePort: 9000,
    qr: false,
  });

  assert.match(pairing.sshCommand, /-p 2222/);
  assert.match(pairing.sshCommand, /-L 9000:127\.0\.0\.1:9100/);
  assert.equal(pairing.url, 'http://127.0.0.1:9000/', 'the URL follows the phone port');
  assert.equal(pairing.tokenUrl, undefined, 'no token URL without DSH connection support');
});

test('describePairing summarises the two phone steps', async () => {
  const pairing = await buildPairing({
    ssh: { host: 'relay.example.com', port: 22, username: 'dsh' },
    forward: { bindAddress: '127.0.0.1', remotePort: 9100 },
    phonePort: 9100,
    authenticatedUrl: (url) => `${url}?token=abc`,
    qr: false,
  });

  const text = describePairing(pairing);
  assert.match(text, /ssh -N/);
  assert.match(text, /http:\/\/127\.0\.0\.1:9100\//);
});

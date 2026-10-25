/**
 * Unit tests for `known_hosts` parsing and host key policy decisions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';

import { appendKnownHost, parseKnownHosts, verifyHostKey } from '../lib/host-key.mjs';

/**
 * Build a public key blob from a fresh key pair.
 * @returns {{ blob: Buffer, base64: string }} Key material.
 */
function freshKey() {
  const pair = ssh2.utils.generateKeyPairSync('ed25519');
  const base64 = pair.public.split(' ')[1];
  return { blob: Buffer.from(base64, 'base64'), base64 };
}

/**
 * A temp directory for one test.
 * @returns {string} Directory path.
 */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-bridge-hk-'));
}

test('strict refuses a host with no known_hosts entry', () => {
  const { blob } = freshKey();
  const result = verifyHostKey({
    policy: 'strict',
    host: 'example.com',
    port: 22,
    key: blob,
    knownHostsPath: path.join(tempDir(), 'known_hosts'),
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /no known_hosts entry/);
});

test('an unknown policy fails closed to strict', () => {
  const { blob } = freshKey();
  const result = verifyHostKey({
    policy: 'please-let-me-in',
    host: 'example.com',
    port: 22,
    key: blob,
    knownHostsPath: path.join(tempDir(), 'known_hosts'),
  });
  assert.equal(result.allowed, false);
});

test('accept-new records an unknown host and then verifies it', () => {
  const dir = tempDir();
  const knownHostsPath = path.join(dir, 'known_hosts');
  const { blob, base64 } = freshKey();

  const first = verifyHostKey({ policy: 'accept-new', host: '10.0.0.5', port: 2222, key: blob, knownHostsPath });
  assert.equal(first.allowed, true);
  assert.equal(first.firstUse, true);

  appendKnownHost(knownHostsPath, '10.0.0.5', 2222, blob);
  const stored = fs.readFileSync(knownHostsPath, 'utf8');
  assert.equal(stored, `[10.0.0.5]:2222 ssh-ed25519 ${base64}\n`);

  const second = verifyHostKey({ policy: 'strict', host: '10.0.0.5', port: 2222, key: blob, knownHostsPath });
  assert.equal(second.allowed, true, 'a recorded key satisfies strict');
});

test('accept-new refuses a changed key for a known host', () => {
  const dir = tempDir();
  const knownHostsPath = path.join(dir, 'known_hosts');
  const original = freshKey();
  const impostor = freshKey();
  appendKnownHost(knownHostsPath, '10.0.0.5', 22, original.blob);

  const result = verifyHostKey({ policy: 'accept-new', host: '10.0.0.5', port: 22, key: impostor.blob, knownHostsPath });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /does not match/);
});

test('a @revoked key is refused even when it matches', () => {
  const dir = tempDir();
  const knownHostsPath = path.join(dir, 'known_hosts');
  const { blob, base64 } = freshKey();
  fs.writeFileSync(knownHostsPath, `@revoked example.com ssh-ed25519 ${base64}\n`);

  const result = verifyHostKey({ policy: 'accept-new', host: 'example.com', port: 22, key: blob, knownHostsPath });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /revoked/);
});

test('a hashed host field matches the same authority', () => {
  const salt = Buffer.from('0123456789abcdef');
  const hash = createHmac('sha1', salt).update('[example.com]:2222').digest('base64');
  const { blob, base64 } = freshKey();
  const contents = `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${base64}\n`;

  const parsed = parseKnownHosts(contents, 'example.com', 2222);
  assert.equal(parsed.entries.length, 1, 'the hashed entry was selected');

  const wrongPort = parseKnownHosts(contents, 'example.com', 22);
  assert.equal(wrongPort.entries.length, 0, 'the hash is bound to the authority');
});

test('wildcards and negations are honoured', () => {
  const { base64 } = freshKey();
  const contents = `*.example.com ssh-ed25519 ${base64}\n!secret.example.com ssh-ed25519 ${base64}\n`;

  assert.equal(parseKnownHosts(contents, 'app.example.com', 22).entries.length, 1);
  assert.equal(parseKnownHosts(contents, 'deep.app.example.com', 22).entries.length, 1);
  assert.equal(parseKnownHosts(contents, 'example.org', 22).entries.length, 0);
});

test('a bare port field is matched only on that port', () => {
  const { base64 } = freshKey();
  const contents = `example.com:2222 ssh-ed25519 ${base64}\n`;
  assert.equal(parseKnownHosts(contents, 'example.com', 2222).entries.length, 1);
  assert.equal(parseKnownHosts(contents, 'example.com', 22).entries.length, 0);
});

test('the insecure policy accepts without looking at known_hosts', () => {
  const { blob } = freshKey();
  const result = verifyHostKey({
    policy: 'insecure',
    host: 'example.com',
    port: 22,
    key: blob,
    knownHostsPath: path.join(tempDir(), 'known_hosts'),
  });
  assert.equal(result.allowed, true);
  assert.match(result.reason, /insecure/);
});

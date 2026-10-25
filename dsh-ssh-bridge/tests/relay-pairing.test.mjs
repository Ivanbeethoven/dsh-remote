/**
 * Relay configuration resolution and pairing links.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveConfig } from '../lib/index.mjs';
import { buildRelayPairing, describePairing } from '../lib/pairing.mjs';

test('relay configuration falls back to ssh.host and mirrors the port', () => {
  const resolved = resolveConfig({
    transport: 'relay',
    ssh: { host: 'relay.example.com' },
    relay: { token: 'host-token', accessToken: 'access-token' },
  });

  assert.equal(resolved.transport, 'relay');
  assert.equal(resolved.relay.host, 'relay.example.com', 'relay.host falls back to ssh.host');
  assert.equal(resolved.relay.port, 8443);
  assert.equal(resolved.relay.publicPort, 8443, 'publicPort follows port when unset');
  assert.equal(resolved.relay.publicHost, '');
});

test('an explicit relay host, port, and public port win', () => {
  const resolved = resolveConfig({
    transport: 'relay',
    ssh: { host: 'ignored.example.com' },
    relay: {
      host: 'relay.example.com',
      port: 9443,
      publicPort: 443,
      publicHost: 'relay.example.com',
      fingerprint: 'ab:cd:ef',
    },
  });

  assert.equal(resolved.relay.host, 'relay.example.com');
  assert.equal(resolved.relay.port, 9443);
  assert.equal(resolved.relay.publicPort, 443);
  assert.equal(resolved.relay.publicHost, 'relay.example.com');
  assert.equal(resolved.relay.fingerprint, 'AB:CD:EF', 'fingerprints are normalised to upper case');
});

test('an unknown transport falls back to ssh', () => {
  assert.equal(resolveConfig({ transport: 'carrier-pigeon' }).transport, 'ssh');
});

test('relay pairing builds a browser URL and a one-click gate link', async () => {
  const pairing = await buildRelayPairing({
    relay: { host: 'relay.example.com', publicHost: '', publicPort: 8443, accessToken: 'acc-123' },
    authenticatedUrl: (url) => `${url}&token=launch-token`,
    qr: false,
  });

  assert.equal(pairing.mode, 'relay');
  assert.equal(pairing.url, 'https://relay.example.com:8443/');
  assert.equal(pairing.tokenUrl, 'https://relay.example.com:8443/?rk=acc-123&token=launch-token');
  assert.equal(pairing.qrDataUrl, undefined);
});

test('relay pairing prefers publicHost and omits rk when no access key is set', async () => {
  const withDomain = await buildRelayPairing({
    relay: { host: '10.0.0.1', publicHost: 'relay.example.com', publicPort: 443, accessToken: 'k' },
    qr: false,
  });
  assert.equal(withDomain.url, 'https://relay.example.com:443/');

  const withoutKey = await buildRelayPairing({
    relay: { host: 'relay.example.com', publicHost: '', publicPort: 8443, accessToken: '' },
    qr: false,
  });
  assert.equal(withoutKey.url, 'https://relay.example.com:8443/');
  assert.equal(withoutKey.tokenUrl, undefined);
});

test('relay pairing brackets an IPv6 literal', async () => {
  const pairing = await buildRelayPairing({
    relay: { host: '2408::1', publicHost: '', publicPort: 8443, accessToken: 'k' },
    qr: false,
  });
  assert.equal(pairing.url, 'https://[2408::1]:8443/');
});

test('describePairing adapts to the transport', async () => {
  const relayPairing = await buildRelayPairing({
    relay: { host: 'relay.example.com', publicHost: '', publicPort: 8443, accessToken: 'acc' },
    qr: false,
  });
  const text = describePairing(relayPairing);
  assert.match(text, /open: https:\/\/relay\.example\.com:8443\//);
  assert.doesNotMatch(text, /ssh -N/);
});

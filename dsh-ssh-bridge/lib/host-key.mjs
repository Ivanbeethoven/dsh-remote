/**
 * OpenSSH `known_hosts` verification for the bridge's outbound SSH client.
 *
 * ssh2 hands us the server's public key as a raw Buffer; `known_hosts` stores the
 * same key as its wire-format blob (type string + key material) in base64. The two
 * representations differ between ssh2 versions, so every key is reduced to its key
 * material before comparison and the prefix is detected by inspecting the blob.
 *
 * Supported entry forms: `host`, `[host]:port`, comma-separated lists, wildcards,
 * negations, `@revoked`, and hashed (`|1|salt|hash`) host fields.
 *
 * @module dsh-ssh-bridge/host-key
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Wire-format public key type names this module recognises when stripping a prefix. */
const KEY_TYPE_PATTERN = /^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256))(@openssh\.com)?$/;

/**
 * Split a wire-format blob into its type string and key material.
 * @param {Buffer} blob - A candidate SSH public key blob.
 * @returns {{ type?: string, raw: Buffer }} The type when the prefix is recognisable.
 */
function splitBlob(blob) {
  if (blob.length < 5) return { raw: blob };
  const length = blob.readUInt32BE(0);
  if (length <= 0 || length > 64 || 4 + length > blob.length) return { raw: blob };
  const type = blob.toString('utf8', 4, 4 + length);
  if (!KEY_TYPE_PATTERN.test(type)) return { raw: blob };
  return { type, raw: blob.subarray(4 + length) };
}

/**
 * Reduce a public key to comparable key material.
 * @param {Buffer} blob - Wire-format blob or bare key material.
 * @returns {string} Base64 of the key material.
 */
function keyMaterial(blob) {
  return splitBlob(blob).raw.toString('base64');
}

/**
 * The host field OpenSSH hashes: `host` on port 22, `[host]:port` otherwise.
 * @param {string} host - Server hostname.
 * @param {number} port - Server port.
 * @returns {string} The hashed host field input.
 */
function hashedHostInput(host, port) {
  return port === 22 ? host : `[${host}]:${port}`;
}

/**
 * Match one `known_hosts` host field against the server we are dialling.
 * @param {string} field - The entry's host field, possibly hashed or negated.
 * @param {string} host - Server hostname.
 * @param {number} port - Server port.
 * @returns {boolean | undefined} `true`/`false` for a match, `undefined` for a negation hit.
 */
function matchHostField(field, host, port) {
  if (field.startsWith('|1|')) {
    const [, , salt, hash] = field.split('|');
    if (!salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = createHmac('sha1', Buffer.from(salt, 'base64'))
      .update(hashedHostInput(host, port))
      .digest();
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  const negated = field.startsWith('!');
  const pattern = negated ? field.slice(1) : field;

  let hostname = pattern;
  let patternPort;
  const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(pattern);
  if (bracketed) {
    hostname = bracketed[1];
    patternPort = bracketed[2] === undefined ? 22 : Number(bracketed[2]);
  } else if (/^[^:]+:\d+$/.test(pattern)) {
    const index = pattern.lastIndexOf(':');
    hostname = pattern.slice(0, index);
    patternPort = Number(pattern.slice(index + 1));
  }
  if (patternPort !== undefined && patternPort !== port) return negated ? undefined : false;

  const literal = hostname.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  const hit = new RegExp(`^${literal}$`, 'i').test(host);
  if (negated) return hit ? undefined : false;
  return hit;
}

/**
 * Parse the `known_hosts` entries that name a host. A `@revoked` key for the same
 * host is reported separately so the caller can refuse it.
 * @param {string} contents - `known_hosts` file contents.
 * @param {string} host - Server hostname.
 * @param {number} port - Server port.
 * @returns {{ entries: { marker?: string, type: string, key: string }[], revoked: Set<string> }}
 */
export function parseKnownHosts(contents, host, port) {
  const entries = [];
  const revoked = new Set();

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const fields = line.split(/\s+/);
    let marker;
    if (fields[0]?.startsWith('@')) marker = fields.shift();
    const [hostField, type, key] = fields;
    if (!hostField || !type || !key) continue;

    let matched = false;
    for (const field of hostField.split(',')) {
      if (matchHostField(field, host, port) === true) matched = true;
    }
    if (!matched) continue;

    if (marker === '@revoked') revoked.add(keyMaterial(Buffer.from(key, 'base64')));
    if (marker === '@cert-authority') continue;
    entries.push({ marker, type, key });
  }

  return { entries, revoked };
}

/**
 * Decide whether a server key may be used under the configured policy.
 *
 * `accept-new` accepts an unknown host only when `known_hosts` holds no entry for
 * it, and still refuses a changed key — this is the trust-on-first-use behaviour of
 * `StrictHostKeyChecking=accept-new`.
 *
 * @param {object} options - Verification inputs.
 * @param {'strict'|'accept-new'|'insecure'} options.policy - Configured policy.
 * @param {string} options.host - Server hostname.
 * @param {number} options.port - Server port.
 * @param {Buffer} options.key - The server's public key blob.
 * @param {string} [options.knownHostsPath] - `known_hosts` path; unset disables storage.
 * @returns {{ allowed: boolean, reason: string, firstUse?: boolean, knownHostsPath?: string }}
 */
export function verifyHostKey({ policy, host, port, key, knownHostsPath }) {
  /* Fail closed: an unrecognised policy is treated as `strict`, never as first-use trust. */
  const effective = policy === 'insecure' ? 'insecure' : policy === 'accept-new' ? 'accept-new' : 'strict';

  if (effective === 'insecure') {
    return { allowed: true, reason: 'host key policy is insecure; the server was not verified' };
  }

  const received = keyMaterial(key);
  const resolvedPath = knownHostsPath ? path.resolve(knownHostsPath) : undefined;

  let contents = '';
  if (resolvedPath !== undefined && fs.existsSync(resolvedPath)) {
    contents = fs.readFileSync(resolvedPath, 'utf8');
  }

  const { entries, revoked } = parseKnownHosts(contents, host, port);

  if (revoked.has(received)) {
    return { allowed: false, reason: `host key for ${host}:${port} is marked @revoked in ${resolvedPath ?? 'known_hosts'}` };
  }

  for (const entry of entries) {
    if (keyMaterial(Buffer.from(entry.key, 'base64')) === received) {
      return { allowed: true, reason: 'host key matches known_hosts' };
    }
  }

  const target = `${host}:${port}`;
  if (entries.length > 0) {
    return {
      allowed: false,
      reason: `host key for ${target} does not match ${resolvedPath ?? 'known_hosts'}; the server key may have changed`,
    };
  }

  if (effective === 'strict') {
    return { allowed: false, reason: `no known_hosts entry for ${target}; add one or set hostKeyPolicy to accept-new` };
  }

  return {
    allowed: true,
    reason: `first connection to ${target}; its host key will be recorded`,
    firstUse: true,
    knownHostsPath: resolvedPath,
  };
}

/**
 * Append a host key to `known_hosts`, creating the file owner-only on first use.
 * @param {string} knownHostsPath - Destination path.
 * @param {string} host - Server hostname.
 * @param {number} port - Server port.
 * @param {Buffer} key - The server's public key blob.
 */
export function appendKnownHost(knownHostsPath, host, port, key) {
  if (!knownHostsPath) return;
  const resolved = path.resolve(knownHostsPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const { type } = splitBlob(key);
  const hostField = port === 22 ? host : `[${host}]:${port}`;
  const keyType = type ?? 'ssh-ed25519';
  const previous = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : '';
  const prefix = previous === '' || previous.endsWith('\n') ? previous : `${previous}\n`;
  fs.writeFileSync(resolved, `${prefix}${hostField} ${keyType} ${key.toString('base64')}\n`, { mode: 0o600 });
}

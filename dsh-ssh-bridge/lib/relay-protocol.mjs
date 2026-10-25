/**
 * Wire contract shared by the relay server and the plugin's relay transport.
 *
 * The relay exposes one public port that both sides use:
 *
 *   DSH host  ──TLS──▶  relay  ◀──TLS──  phone browser
 *
 * A connection is classified by its first bytes. Host connections open with
 * {@link MAGIC} followed by one JSON handshake line; anything else is treated as
 * HTTP from a browser. After the handshake a host connection is a *raw byte pipe*:
 * the relay writes the browser's bytes into it and pipes the reply back, exactly
 * like`ssh -L`, so HTTP keep-alive, chunked bodies, and WebSocket upgrades all work
 * without this project parsing them.
 *
 * @module dsh-ssh-bridge/relay-protocol
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Marks a host connection before its JSON handshake line. */
export const MAGIC = Buffer.from('DSH1\n');

/** Version of the handshake payload. */
export const HANDSHAKE_VERSION = 1;

/** Prefix reserved for relay-local endpoints; never proxied to a host. */
export const RESERVED_PREFIX = '/__relay/';

/**
 * Compile the handshake a host sends immediately after {@link MAGIC}.
 * @param {object} fields - Handshake fields.
 * @param {string} fields.hostId - Logical host identifier.
 * @param {string} fields.token - Shared host token.
 * @returns {Buffer} `MAGIC`-less JSON line, newline terminated.
 */
export function encodeHandshake({ hostId, token }) {
  return Buffer.from(`${JSON.stringify({ v: HANDSHAKE_VERSION, hostId, token })}\n`);
}

/**
 * Compare two secrets without leaking their lengths through timing.
 * @param {unknown} actual - Candidate supplied by a peer.
 * @param {unknown} expected - Configured secret.
 * @returns {boolean} Whether they are byte-identical.
 */
export function tokenEquals(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  if (expected === '') return false;
  const left = createHash('sha256').update(actual).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

/**
 * Classify the first bytes of a TLS connection.
 * @param {Buffer} head - Bytes received so far.
 * @returns {'host' | 'browser' | 'unknown'} Verdict, or `unknown` while undecidable.
 */
export function classify(head) {
  const limit = Math.min(head.length, MAGIC.length);
  for (let index = 0; index < limit; index += 1) {
    if (head[index] !== MAGIC[index]) return 'browser';
  }
  return head.length >= MAGIC.length ? 'host' : 'unknown';
}

/**
 * Format a SHA-256 certificate fingerprint the way browsers and `openssl` print it.
 * @param {Buffer} der - DER encoded certificate.
 * @returns {string} Colon-separated upper-case hex pairs.
 */
export function fingerprintOf(der) {
  return createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g).join(':');
}

/**
 * Read one `Cookie` header value.
 * @param {string | undefined} header - Raw `cookie` header.
 * @param {string} name - Cookie name.
 * @returns {string | undefined} The value, when present.
 */
export function readCookie(header, name) {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return part.slice(index + 1).trim();
  }
  return undefined;
}

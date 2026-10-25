/**
 * TLS material for the relay.
 *
 * The relay terminates TLS itself, so it needs a certificate. A real certificate (and a
 * domain pointing at the relay) is the best outcome; without one the relay generates a
 * self-signed certificate for the addresses it serves and prints its SHA-256 fingerprint,
 * which the plugin can pin so an interception attempt fails loudly instead of silently.
 *
 * Certificate generation deliberately has two paths: the optional `selfsigned` package
 * when it is installed, and the system `openssl` otherwise. That keeps a production
 * deployment free of npm dependencies — Node plus OpenSSL is all the relay needs.
 *
 * @module dsh-ssh-bridge/relay-cert
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { fingerprintOf } from './relay-protocol.mjs';

/**
 * Whether a host string is an IP literal rather than a DNS name.
 * @param {string} host - Address or name.
 * @returns {boolean} True for IPv4 or IPv6 literals.
 */
function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/**
 * Generate a self-signed key pair with the optional `selfsigned` package.
 * @param {object} options - Generation inputs.
 * @param {string} options.commonName - Certificate CN.
 * @param {{ type: 2 | 7, value?: string, ip?: string }[]} options.altNames - SAN entries.
 * @returns {Promise<{ cert: string, key: string }>} PEM pair.
 */
async function generateWithPackage({ commonName, altNames }) {
  const module = await import('selfsigned');
  const selfsigned = module.default ?? module;
  const pair = selfsigned.generate(
    [{ name: 'commonName', value: commonName }],
    {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames }],
    },
  );
  return { cert: pair.cert, key: pair.private };
}

/**
 * Generate a self-signed key pair with the system `openssl`.
 * @param {object} options - Generation inputs.
 * @param {string} options.commonName - Certificate CN.
 * @param {{ type: 2 | 7, value?: string, ip?: string }[]} options.altNames - SAN entries.
 * @param {string} options.dir - Directory to write the PEM files into.
 * @returns {{ cert: string, key: string }} PEM pair.
 */
function generateWithOpenssl({ commonName, altNames, dir }) {
  const keyPath = path.join(dir, '.openssl-key.pem');
  const certPath = path.join(dir, '.openssl-cert.pem');
  const subjectAltName = altNames
    .map((entry) => (entry.type === 7 ? `IP:${entry.ip}` : `DNS:${entry.value}`))
    .join(',');

  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-subj', `/CN=${commonName}`,
      '-addext', `subjectAltName=${subjectAltName}`,
    ], { stdio: 'pipe', timeout: 60_000 });
    return { cert: fs.readFileSync(certPath, 'utf8'), key: fs.readFileSync(keyPath, 'utf8') };
  } finally {
    fs.rmSync(keyPath, { force: true });
    fs.rmSync(certPath, { force: true });
  }
}

/**
 * Load the configured certificate, or generate and persist a self-signed one.
 *
 * @param {object} options - Certificate inputs.
 * @param {string} [options.certFile] - PEM certificate path.
 * @param {string} [options.keyFile] - PEM key path.
 * @param {string[]} options.hosts - DNS names and IPs the certificate must cover.
 * @returns {Promise<{ cert: string, key: string, generated: boolean, fingerprint: string, generator?: string }>}
 */
export async function ensureCertificate({ certFile, keyFile, hosts }) {
  if (certFile !== undefined && keyFile !== undefined && fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const cert = fs.readFileSync(certFile, 'utf8');
    const key = fs.readFileSync(keyFile, 'utf8');
    return { cert, key, generated: false, fingerprint: fingerprintOf(new crypto.X509Certificate(cert).raw) };
  }

  if (certFile === undefined || keyFile === undefined) {
    throw new Error('relay: certFile and keyFile are required when they are not generated');
  }

  const altNames = [];
  for (const host of hosts) {
    if (host === '' || host === '0.0.0.0' || host === '::') continue;
    altNames.push(isIpLiteral(host) ? { type: 7, ip: host } : { type: 2, value: host });
  }
  if (!altNames.some((entry) => entry.type === 7 && entry.ip === '127.0.0.1')) {
    altNames.push({ type: 7, ip: '127.0.0.1' });
  }
  if (!altNames.some((entry) => entry.type === 2 && entry.value === 'localhost')) {
    altNames.push({ type: 2, value: 'localhost' });
  }

  const commonName = hosts.find((host) => host !== '' && host !== '0.0.0.0' && host !== '::') ?? 'dsh-relay';
  const dir = path.dirname(path.resolve(certFile));
  fs.mkdirSync(dir, { recursive: true });

  let pair;
  let generator;
  try {
    pair = await generateWithPackage({ commonName, altNames });
    generator = 'selfsigned';
  } catch (error) {
    try {
      pair = generateWithOpenssl({ commonName, altNames, dir });
      generator = 'openssl';
    } catch (opensslError) {
      throw new Error(
        'relay: cannot generate a certificate: install the optional "selfsigned" package, '
        + `or make openssl available (${opensslError instanceof Error ? opensslError.message : String(opensslError)})`,
      );
    }
  }

  fs.writeFileSync(certFile, pair.cert, { mode: 0o600 });
  fs.writeFileSync(keyFile, pair.key, { mode: 0o600 });

  return {
    cert: pair.cert,
    key: pair.key,
    generated: true,
    generator,
    fingerprint: fingerprintOf(new crypto.X509Certificate(pair.cert).raw),
  };
}

#!/usr/bin/env node
/**
 * Run the DSH relay as a standalone process.
 *
 * This is the only thing that has to run on the public server. It has no dependencies
 * beyond Node and this package.
 *
 *   node bin/dsh-relay.mjs --port 8443 --host relay.example.com
 *   node bin/dsh-relay.mjs --http --port 8080 --hosts-file ./hosts.json
 *
 * Tokens are generated and printed on first run when not supplied; pass them explicitly to
 * keep them stable across restarts. `--hosts-file` serves several DSH machines on one port:
 * each entry's accessToken is the routing key the browser presents.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

import { createRelay } from '../lib/relay-server.mjs';

/**
 * Parse `--name value` and `--flag` arguments.
 * @param {string[]} argv - Arguments after the script name.
 * @returns {Record<string, string | boolean>} Parsed flags.
 */
function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

const args = parseArgs(process.argv.slice(2));

if (args.help === true) {
  console.log(`Usage: dsh-relay [options]

  --port <n>           public port (default 8443; 0 picks a free one)
  --bind <addr>        bind address (default 0.0.0.0)
  --host <name>        address to put in the certificate SAN (repeatable)
  --http               serve plain HTTP instead of TLS. The access key and the DSH launch
                       token then cross the network in clear text — opt in deliberately.
  --hosts-file <file>  JSON array of { hostId, hostToken, accessToken } to serve several
                       DSH machines on one port (each accessToken routes its own host)
  --host-token <s>     single-host mode: secret the DSH host presents (default: generated)
  --access-token <s>   single-host mode: secret the browser presents once (default: generated)
  --host-id <id>       single-host mode: logical host name (default: default)
  --cert <file>        PEM certificate (default: generated, self-signed; TLS only)
  --key <file>         PEM private key (default: generated, self-signed; TLS only)
  --pool <n>           idle host connections kept per host (default 16)
`);
  process.exit(0);
}

const port = args.port === undefined ? 8443 : Number(args.port);
const bind = typeof args.bind === 'string' ? args.bind : '0.0.0.0';
const secure = args.http !== true;

const certHosts = [];
for (let index = 0; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--host') certHosts.push(process.argv[index + 1]);
}
if (certHosts.length === 0 && bind !== '0.0.0.0') certHosts.push(bind);

/**
 * Load the multi-host table, or build the single-host shorthand.
 * @returns {{ hostId: string, hostToken: string, accessToken: string }[]} Hosts to serve.
 */
function resolveHosts() {
  if (typeof args['hosts-file'] === 'string') {
    const raw = fs.readFileSync(args['hosts-file'], 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(`${args['hosts-file']} must be a non-empty JSON array of { hostId, hostToken, accessToken }`);
    }
    return parsed;
  }
  return [{
    hostId: typeof args['host-id'] === 'string' ? args['host-id'] : 'default',
    hostToken: typeof args['host-token'] === 'string'
      ? args['host-token']
      : crypto.randomBytes(24).toString('base64url'),
    accessToken: typeof args['access-token'] === 'string'
      ? args['access-token']
      : crypto.randomBytes(18).toString('base64url'),
  }];
}

const hosts = resolveHosts();

const relay = await createRelay({
  port,
  bind,
  secure,
  hosts,
  certFile: typeof args.cert === 'string' ? args.cert : './relay-cert.pem',
  keyFile: typeof args.key === 'string' ? args.key : './relay-key.pem',
  certHosts,
  poolSize: args.pool === undefined ? 16 : Number(args.pool),
  log: (level, message) => console.log(`[${level}] ${message}`),
});

const scheme = secure ? 'https' : 'http';
console.log('');
console.log(`[relay] listening on ${scheme}://${bind}:${relay.port}`);
if (secure) {
  console.log(`[relay] certificate: ${relay.generatedCertificate ? 'self-signed, generated' : 'loaded from file'}`);
  console.log(`[relay] SHA-256 fingerprint: ${relay.fingerprint}`);
} else {
  console.log('[relay] WARNING: plain HTTP — the access key and the DSH launch token are not encrypted');
}
console.log('');
console.log(`[relay] serving ${hosts.length} host(s):`);
for (const host of hosts) {
  console.log(`  - ${host.hostId}`);
  console.log(`      accessToken: ${host.accessToken}`);
  console.log(`      hostToken  : ${host.hostToken}`);
}
console.log('');
console.log('[relay] plugin configuration per host (transport: relay):');
for (const host of hosts) {
  console.log(`  # ${host.hostId}`);
  console.log(`  relay:`);
  console.log(`    host: ${certHosts[0] ?? '<relay address>'}`);
  console.log(`    port: ${relay.port}`);
  console.log(`    protocol: ${scheme}`);
  console.log(`    publicHost: ${certHosts[0] ?? '<relay address>'}`);
  console.log(`    hostId: ${host.hostId}`);
  console.log(`    token: '${host.hostToken}'`);
  console.log(`    accessToken: '${host.accessToken}'`);
  if (secure) console.log(`    fingerprint: '${relay.fingerprint}'`);
  console.log('');
}

const shutdown = async () => {
  console.log('\n[relay] shutting down');
  await relay.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

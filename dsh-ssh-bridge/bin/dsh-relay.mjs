#!/usr/bin/env node
/**
 * Run the DSH relay as a standalone process.
 *
 * This is the only thing that has to run on the public server. It has no
 * dependencies beyond Node and this package.
 *
 *   node bin/dsh-relay.mjs --port 8443 --host relay.example.com
 *
 * Tokens are generated and printed on first run when not supplied; pass them
 * explicitly to keep them stable across restarts.
 */

import crypto from 'node:crypto';

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
  --host-token <s>     secret the DSH host presents (default: generated)
  --access-token <s>   secret the browser presents once (default: generated)
  --host-id <id>       logical host name (default: default)
  --cert <file>        PEM certificate (default: generated, self-signed)
  --key <file>         PEM private key (default: generated, self-signed)
  --pool <n>           idle host connections kept (default 16)
`);
  process.exit(0);
}

const port = args.port === undefined ? 8443 : Number(args.port);
const bind = typeof args.bind === 'string' ? args.bind : '0.0.0.0';
const hosts = [];
for (let index = 0; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--host') hosts.push(process.argv[index + 1]);
}
if (hosts.length === 0 && bind !== '0.0.0.0') hosts.push(bind);

const hostToken = typeof args['host-token'] === 'string'
  ? args['host-token']
  : crypto.randomBytes(24).toString('base64url');
const accessToken = typeof args['access-token'] === 'string'
  ? args['access-token']
  : crypto.randomBytes(18).toString('base64url');

const relay = await createRelay({
  port,
  bind,
  hostToken,
  accessToken,
  hostId: typeof args['host-id'] === 'string' ? args['host-id'] : 'default',
  certFile: typeof args.cert === 'string' ? args.cert : './relay-cert.pem',
  keyFile: typeof args.key === 'string' ? args.key : './relay-key.pem',
  hosts,
  poolSize: args.pool === undefined ? 16 : Number(args.pool),
  log: (level, message) => console.log(`[${level}] ${message}`),
});

console.log('');
console.log(`[relay] listening on https://${bind}:${relay.port}`);
console.log(`[relay] certificate: ${relay.generatedCertificate ? 'self-signed, generated' : 'loaded from file'}`);
console.log(`[relay] SHA-256 fingerprint: ${relay.fingerprint}`);
console.log('');
console.log(`[relay] host token    : ${hostToken}`);
console.log(`[relay] access token  : ${accessToken}`);
console.log('');
console.log('[relay] plugin configuration to paste into the DSH profile:');
console.log(`  transport: relay`);
console.log(`  relay:`);
console.log(`    host: ${hosts[0] ?? '<relay address>'}`);
console.log(`    port: ${relay.port}`);
console.log(`    publicHost: ${hosts[0] ?? '<relay address>'}`);
console.log(`    token: '${hostToken}'`);
console.log(`    accessToken: '${accessToken}'`);
console.log(`    fingerprint: '${relay.fingerprint}'`);
console.log('');

const shutdown = async () => {
  console.log('\n[relay] shutting down');
  await relay.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

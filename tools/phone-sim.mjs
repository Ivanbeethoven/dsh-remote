/**
 * Phone simulator for the SSH bridge.
 *
 * Reproduces what a phone does after `ssh -N -L <phonePort>:127.0.0.1:<forwardPort>`:
 * a raw TCP forward on the phone's loopback, then a browser session at
 * http://127.0.0.1:<phonePort>/ — the same authority DSH's trust fence sees on a phone.
 *
 * Usage:
 *   node tools/phone-sim.mjs --forward-port 9393 --phone-port 9191 --token <launch token>
 */

import net from 'node:net';

/**
 * Read `--name value` flags.
 * @returns {Record<string, string>} Flags.
 */
function flags() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (key?.startsWith('--')) out[key.slice(2)] = argv[index + 1];
  }
  return out;
}

const args = flags();
const forwardPort = Number(args['forward-port']);
const phonePort = Number(args['phone-port']);
const token = args.token;

/** Start the phone-side forward. */
const proxy = net.createServer((socket) => {
  const upstream = net.connect({ host: '127.0.0.1', port: forwardPort });
  socket.on('error', () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
  socket.pipe(upstream).pipe(socket);
});

await new Promise((resolve, reject) => {
  proxy.once('error', reject);
  proxy.listen(phonePort, '127.0.0.1', resolve);
});
console.log(`[phone] ssh -L ${phonePort}:127.0.0.1:${forwardPort} is up`);

const base = `http://127.0.0.1:${phonePort}`;

let cookie;
if (token !== undefined) {
  const exchange = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
  const setCookie = exchange.headers.getSetCookie?.() ?? [];
  cookie = setCookie.map((entry) => entry.split(';')[0]).join('; ');
  console.log(`[phone] token exchange -> ${exchange.status} (${exchange.headers.get('location')})`);
  console.log(`[phone] cookie -> ${cookie === '' ? '(none)' : cookie.split('=')[0] + '=…'}`);
}

const headers = cookie === undefined || cookie === '' ? {} : { cookie };

const index = await fetch(`${base}/`, { headers });
const html = await index.text();
console.log(`[phone] GET / -> ${index.status}, ${html.length} bytes`);
console.log(`[phone]   looks like the DSH shell: ${/__DSH_BOOT__|<div id="root"|dsh/i.test(html)}`);

const status = await fetch(`${base}/ssh-bridge/status`, { headers });
const body = await status.text();
console.log(`[phone] GET /ssh-bridge/status -> ${status.status}`);
if (status.status === 200) {
  const parsed = JSON.parse(body);
  console.log(`[phone]   state=${parsed.state} forward=${parsed.forward.bindAddress}:${parsed.forward.remotePort} -> ${parsed.forward.target.host}:${parsed.forward.target.port}`);
  console.log(`[phone]   pairing.url=${parsed.pairing?.url} tokenUrl=${parsed.pairing?.tokenUrl === null ? 'null' : 'present'}`);
  console.log(`[phone]   ssh: ${parsed.pairing?.sshCommand}`);
} else {
  console.log(body.slice(0, 200));
}

proxy.close();
process.exit(index.status === 200 && status.status === 200 ? 0 : 1);

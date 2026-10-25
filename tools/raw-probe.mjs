/**
 * One raw request, no redirect following, full response headers.
 *
 * Usage: node tools/raw-probe.mjs <url> [cookie]
 */

import https from 'node:https';

const [rawUrl, cookie] = process.argv.slice(2);
const url = new URL(rawUrl);

https.get({
  host: url.hostname,
  port: url.port,
  path: `${url.pathname}${url.search}`,
  rejectUnauthorized: false,
  timeout: 15_000,
  headers: {
    host: url.host,
    ...(cookie === undefined ? {} : { cookie }),
  },
}, (response) => {
  let body = '';
  response.setEncoding('utf8');
  response.on('data', (chunk) => { body += chunk; });
  response.on('end', () => {
    console.log(`status: ${response.statusCode}`);
    for (const [name, value] of Object.entries(response.headers)) {
      console.log(`  ${name}: ${Array.isArray(value) ? value.join(' | ') : value}`);
    }
    console.log(`body: ${body.length} bytes`);
    console.log(body.slice(0, 200).replace(/\n/g, ' '));
  });
}).on('error', (error) => console.log('ERR', error.message));

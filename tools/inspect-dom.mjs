/**
 * Inspect a dumped DOM to see whether the DSH client actually mounted.
 *
 * Usage: node tools/inspect-dom.mjs <domFile>
 */

import fs from 'node:fs';

const [file] = process.argv.slice(2);
if (file === undefined) {
  console.error('usage: node tools/inspect-dom.mjs <domFile>');
  process.exit(2);
}

const html = fs.readFileSync(file, 'utf8');
console.log(`dom: ${html.length} bytes`);

const rootMatch = /<div id="root"[^>]*>([\s\S]*?)<\/div>\s*<script/.exec(html)
  ?? /<div id="root"[^>]*>([\s\S]{0,400})/.exec(html);
console.log(`has #root        : ${html.includes('id="root"')}`);
if (rootMatch !== null) {
  const inner = rootMatch[1];
  console.log(`#root inner      : ${inner.length} bytes`);
  console.log(`#root snippet    : ${JSON.stringify(inner.slice(0, 200))}`);
}

const text = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
console.log(`visible text     : ${text.length} chars`);
console.log(`text sample      : ${JSON.stringify(text.slice(0, 300))}`);

const markers = {
  'session/sidebar words': /会话|session|workspace|composer|发送|输入/i,
  'react root hydrated': /class="[^"]*(dsh|layout|sidebar)/i,
  'boot payload': /__DSH_BOOT__/,
  'error banner': /error|failed|not connected/i,
};
for (const [label, pattern] of Object.entries(markers)) {
  console.log(`  ${label.padEnd(22)}: ${pattern.test(html) ? 'yes' : 'no'}`);
}

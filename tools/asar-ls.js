// Minimal read-only ASAR inspector: lists entries, optionally filtering by regex.
// Usage: node asar-ls.js <archive> [regex] [--max N]
const fs = require('fs');

const archive = process.argv[2];
const pattern = process.argv[3] && process.argv[3] !== '--max' ? new RegExp(process.argv[3]) : null;
const maxIdx = process.argv.indexOf('--max');
const max = maxIdx > 0 ? parseInt(process.argv[maxIdx + 1], 10) : 200;

const fd = fs.openSync(archive, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerLen = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(headerLen);
fs.readSync(fd, jsonBuf, 0, headerLen, 16);
fs.closeSync(fd);

const header = JSON.parse(jsonBuf.toString('utf8'));
const out = [];
(function walk(node, prefix) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (val.files) walk(val, p);
    else out.push({ path: p, size: val.size, unpacked: !!val.unpacked });
  }
})(header, '');

let shown = 0;
for (const e of out.sort((a, b) => a.path.localeCompare(b.path))) {
  if (pattern && !pattern.test(e.path)) continue;
  console.log(`${String(e.size ?? '').padStart(10)} ${e.unpacked ? 'U' : ' '} ${e.path}`);
  if (++shown >= max) { console.log(`... truncated at ${max} of ${out.length} total entries`); break; }
}
console.error(`[asar-ls] total entries: ${out.length}, shown: ${shown}`);

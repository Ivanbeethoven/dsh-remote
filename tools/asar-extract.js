// Minimal ASAR extractor: extracts entries matching a regex, preserving paths.
// Usage: node asar-extract.js <archive> <destDir> <regex> [--max N]
const fs = require('fs');
const path = require('path');

const [, , archive, destDir, patternArg, ...rest] = process.argv;
const pattern = new RegExp(patternArg);
const maxIdx = rest.indexOf('--max');
const max = maxIdx >= 0 ? parseInt(rest[maxIdx + 1], 10) : 5000;

const fd = fs.openSync(archive, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerLen = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(headerLen);
fs.readSync(fd, jsonBuf, 0, headerLen, 16);
const header = JSON.parse(jsonBuf.toString('utf8'));
const baseOffset = 8 + head.readUInt32LE(4);

const out = [];
(function walk(node, prefix) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (val.files) walk(val, p);
    else out.push({ path: p, size: val.size || 0, offset: val.offset, unpacked: !!val.unpacked });
  }
})(header, '');

let n = 0;
for (const e of out) {
  if (n >= max) break;
  if (!pattern.test(e.path)) continue;
  if (e.unpacked) continue;
  const dest = path.join(destDir, e.path);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const buf = Buffer.alloc(e.size);
  if (e.size > 0) fs.readSync(fd, buf, 0, e.size, baseOffset + Number(e.offset));
  fs.writeFileSync(dest, buf);
  n++;
}
fs.closeSync(fd);
console.log(`extracted ${n} entries to ${destDir}`);

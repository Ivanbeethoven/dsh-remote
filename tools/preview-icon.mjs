/**
 * Render the adaptive icon the way Android composites it, so it can be eyeballed.
 *
 * Android draws both layers at 108dp, then masks the central 72dp with the launcher's
 * shape — so 18dp on every edge is already outside the visible area. This script applies
 * exactly that crop, then shows the result under a circle mask, a squircle mask, and at
 * 48px (the size a launcher actually draws in a drawer).
 *
 * Both layers are drawn into a single document on purpose: compositing two separately
 * rasterised SVGs invites density mismatches, and the preview only needs the final look.
 *
 * Usage: node tools/preview-icon.mjs
 */

import sharp from 'sharp';
import fs from 'node:fs';

const NAVY = '#12203A';
const BAND = '#1B2F52';
const ACCENT = '#38BDF8';
const INK = '#E2E8F0';

const SCALE = 4;
const CANVAS = 108 * SCALE;      // 432
const VISIBLE = 72 * SCALE;      // 288 — the masked area
const OFFSET = 18 * SCALE;       // 72  — crop origin

const iconSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 108 108">
  <!-- background layer -->
  <rect width="108" height="108" fill="${NAVY}"/>
  <path d="M0,86 L108,30 L108,108 L0,108 z" fill="${BAND}"/>
  <!-- foreground layer -->
  <path d="M31,36 L54,54 L31,72" fill="none" stroke="${ACCENT}" stroke-width="6"
        stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M60,72 L78,72" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>
</svg>`;

const composed = await sharp(Buffer.from(iconSvg))
  .resize(CANVAS, CANVAS, { fit: 'fill' })
  .extract({ left: OFFSET, top: OFFSET, width: VISIBLE, height: VISIBLE })
  .png()
  .toBuffer();

const composedMeta = await sharp(composed).metadata();
if (composedMeta.width !== VISIBLE || composedMeta.height !== VISIBLE) {
  throw new Error(`preview canvas is ${composedMeta.width}x${composedMeta.height}, expected ${VISIBLE}x${VISIBLE}`);
}

/**
 * Mask the composed square with a shape.
 * @param {string} shape - SVG shape fragment sized to VISIBLE.
 * @returns {Promise<Buffer>} Masked PNG.
 */
async function masked(shape) {
  const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${VISIBLE}" height="${VISIBLE}" viewBox="0 0 ${VISIBLE} ${VISIBLE}">${shape}</svg>`;
  const mask = await sharp(Buffer.from(maskSvg))
    .resize(VISIBLE, VISIBLE, { fit: 'fill' })
    .png()
    .toBuffer();
  return sharp(composed)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

const circle = await masked(`<circle cx="${VISIBLE / 2}" cy="${VISIBLE / 2}" r="${VISIBLE / 2}" fill="#fff"/>`);
const squircle = await masked(`<rect x="0" y="0" width="${VISIBLE}" height="${VISIBLE}" rx="${VISIBLE * 0.28}" fill="#fff"/>`);

/* 48dp is what a drawer actually draws; upscale 3x with nearest so it stays honest. */
const drawer = await sharp(composed).resize(48, 48).png().toBuffer();
const drawerBig = await sharp(drawer).resize(144, 144, { kernel: 'nearest' }).png().toBuffer();

const SHEET_W = 800;
const SHEET_H = 400;
const sheet = sharp({
  create: { width: SHEET_W, height: SHEET_H, channels: 4, background: '#F1F5F9' },
}).composite([
  { input: circle, left: 24, top: 56 },
  { input: squircle, left: 344, top: 56 },
  { input: drawerBig, left: 632, top: 78 },
]);

const out = 'tools/icon-preview.png';
await sheet.png().toFile(out);
console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`);
console.log('left: circle mask   middle: squircle mask   right: 48dp drawer size (3x, nearest)');

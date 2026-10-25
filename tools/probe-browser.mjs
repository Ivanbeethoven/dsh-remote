/**
 * Load the pairing link in a real Chromium and report what the page actually does:
 * console messages, uncaught errors, failed requests, and whether #root mounted.
 *
 * Usage: node tools/probe-browser.mjs <pairingUrl> [screenshotPath]
 */

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const [url, shot] = process.argv.slice(2);
if (url === undefined) {
  console.error('usage: node tools/probe-browser.mjs <pairingUrl> [screenshotPath]');
  process.exit(2);
}

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = 'C:/dev/probe-profile';
fs.rmSync(profile, { recursive: true, force: true });

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  ignoreHTTPSErrors: true,
  args: [
    '--no-first-run',
    '--disable-gpu',
    `--user-data-dir=${profile}`,
    '--ignore-certificate-errors',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

const consoleLines = [];
const pageErrors = [];
const failed = [];

page.on('console', (message) => {
  consoleLines.push(`[${message.type()}] ${message.text()}`);
});
page.on('pageerror', (error) => {
  pageErrors.push(String(error));
});
page.on('requestfailed', (request) => {
  failed.push(`${request.url().slice(0, 120)} :: ${request.failure()?.errorText ?? '?'}`);
});

console.log(`navigating: ${url.replace(/token=[^&]+/, 'token=<token>').replace(/rk=[^&]+/, 'rk=<key>')}`);
try {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45_000 });
} catch (error) {
  console.log(`goto threw: ${error.message}`);
}

await new Promise((resolve) => setTimeout(resolve, 8000));

const state = await page.evaluate(() => {
  const root = document.querySelector('#root');
  return {
    url: location.href,
    title: document.title,
    rootChildren: root === null ? -1 : root.children.length,
    rootHtmlLength: root === null ? -1 : root.innerHTML.length,
    bodyText: (document.body?.innerText ?? '').slice(0, 300),
    scripts: document.scripts.length,
    modules: [...document.querySelectorAll('script[type="module"]')].map((s) => s.src).slice(0, 6),
    boot: typeof window.__DSH_BOOT__,
    ready: document.readyState,
  };
});

console.log('\n--- page state ---');
console.log(JSON.stringify(state, null, 2));

console.log('\n--- uncaught errors ---');
console.log(pageErrors.length === 0 ? '(none)' : pageErrors.slice(0, 10).join('\n'));

console.log('\n--- console ---');
console.log(consoleLines.length === 0 ? '(none)' : consoleLines.slice(0, 25).join('\n'));

console.log('\n--- failed requests ---');
console.log(failed.length === 0 ? '(none)' : failed.slice(0, 10).join('\n'));

if (shot !== undefined) {
  await page.screenshot({ path: shot, fullPage: false });
  console.log(`\nscreenshot: ${shot}`);
}

await browser.close();
process.exit(pageErrors.length === 0 && state.rootChildren > 0 ? 0 : 1);

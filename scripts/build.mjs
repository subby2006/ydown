import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const experimentalFlag = '--experimental-userscript';
if (!process.argv.includes(experimentalFlag)) {
  throw new Error(
    `The Tampermonkey build is experimental and must be enabled with ${experimentalFlag}. `
    + 'Use "npm run build:userscript" to build it intentionally.',
  );
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, '../../outputs/youtube-browser-downloader.user.js');
const temporaryBundle = resolve(root, 'dist/bundle.js');

await mkdir(dirname(temporaryBundle), { recursive: true });
await mkdir(dirname(output), { recursive: true });

await build({
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile: temporaryBundle,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  minify: true,
  treeShaking: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'eof',
});

const metadata = `// ==UserScript==
// @name         YouTube Local Browser Downloader
// @namespace    local.youtube.downloader
// @version      0.5.2
// @description  Downloads and muxes YouTube streams locally inside the browser.
// @match        https://www.youtube.com/*
// @match        https://youtube.com/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// ==/UserScript==

`;

const bundle = await readFile(temporaryBundle, 'utf8');
await writeFile(output, metadata + bundle, 'utf8');
console.log(output);

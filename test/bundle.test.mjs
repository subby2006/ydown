import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { resolve } from 'node:path';

const output = resolve(process.cwd(), '../../outputs/youtube-browser-downloader.user.js');
const source = await readFile(output, 'utf8');

test('keeps the userscript behind an explicit experimental build flag', async () => {
  const packageJson = JSON.parse(await readFile(resolve(process.cwd(), 'package.json'), 'utf8'));
  const buildSource = await readFile(resolve(process.cwd(), 'scripts/build.mjs'), 'utf8');
  assert.equal(packageJson.scripts.build, 'node scripts/build-extension.mjs');
  assert.match(packageJson.scripts['build:userscript'], /--experimental-userscript/);
  assert.match(buildSource, /process\.argv\.includes\(experimentalFlag\)/);
});

test('builds a self-contained raw userscript', () => {
  assert.match(source, /^\/\/ ==UserScript==/);
  assert.match(source, /\/\/ @grant\s+none/);
  assert.match(source, /\/\/ @sandbox\s+raw/);
  assert.doesNotMatch(source, /\/\/ @require/);
});

test('contains the SABR downloader, local muxer, and native save path', () => {
  assert.match(source, /serverAbrStreamingUrl/);
  assert.match(source, /streamProtectionStatusUpdate/);
  assert.match(source, /showSaveFilePicker/);
  assert.match(source, /getDirectory/);
  assert.match(source, /Muxing locally/);
});

test('does not contain an external conversion service', () => {
  assert.doesNotMatch(source, /ffmpeg\.wasm/i);
  assert.doesNotMatch(source, /cloudconvert|cobalt\.tools|loader\.to/i);
});

test('does not violate YouTube Trusted Types with HTML string sinks', () => {
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /insertAdjacentHTML\s*\(/);
});

import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, '../../outputs/youtube-local-downloader-extension');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

await build({
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile: resolve(output, 'content.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  minify: true,
  treeShaking: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'eof',
});

await Promise.all([
  cp(resolve(root, 'extension/manifest.json'), resolve(output, 'manifest.json')),
  cp(resolve(root, 'README.md'), resolve(output, 'README.md')),
  cp(resolve(root, 'node_modules/googlevideo/LICENSE'), resolve(output, 'LICENSE-googlevideo.txt')),
  cp(resolve(root, 'node_modules/mediabunny/LICENSE'), resolve(output, 'LICENSE-mediabunny.txt')),
]);

console.log(output);

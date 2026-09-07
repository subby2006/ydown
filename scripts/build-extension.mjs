import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, '../../outputs/youtube-local-downloader-extension');

try {
  loadEnvFile(resolve(root, '.env.local'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const notificationIcon = await readFile(resolve(root, 'extension/icon.png.base64'), 'utf8');
await writeFile(resolve(output, 'icon.png'), Buffer.from(notificationIcon.trim(), 'base64'));
const runNumber = process.env.GITHUB_RUN_NUMBER;
const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
const buildId = /^\d+$/.test(runNumber || '') && /^\d+$/.test(runAttempt || '')
  ? `${runNumber}.${runAttempt}`
  : 'dev';
const sentryDsn = (process.env.SENTRY_DSN || '').trim();
if (sentryDsn) {
  const parsedSentryDsn = new URL(sentryDsn);
  if (
    parsedSentryDsn.protocol !== 'https:'
    || parsedSentryDsn.hostname !== 'o4512046378254336.ingest.us.sentry.io'
    || !/^\/\d+\/?$/.test(parsedSentryDsn.pathname)
  ) throw new Error('SENTRY_DSN is not the expected ydown Sentry project DSN.');
}
const backgroundSource = await readFile(resolve(root, 'extension/background.js'), 'utf8');
await writeFile(
  resolve(output, 'background.js'),
  backgroundSource
    .replaceAll('__YDOWN_BUILD_ID__', buildId)
    .replaceAll('__YDOWN_BUILD_TIME__', new Date().toISOString())
    .replaceAll('__YDOWN_SENTRY_DSN__', sentryDsn),
);

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
  cp(resolve(root, 'extension/notification-bridge.js'), resolve(output, 'notification-bridge.js')),
  cp(resolve(root, 'README.md'), resolve(output, 'README.md')),
  cp(resolve(root, 'node_modules/googlevideo/LICENSE'), resolve(output, 'LICENSE-googlevideo.txt')),
  cp(resolve(root, 'node_modules/mediabunny/LICENSE'), resolve(output, 'LICENSE-mediabunny.txt')),
]);

console.log(output);

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { StreamerContext_ClientInfo } from '../node_modules/googlevideo/dist/protos/generated/video_streaming/streamer_context.js';

const extensionRoot = resolve(process.cwd(), '../../outputs/youtube-local-downloader-extension');
const manifest = JSON.parse(await readFile(resolve(extensionRoot, 'manifest.json'), 'utf8'));
const content = await readFile(resolve(extensionRoot, 'content.js'), 'utf8');

test('extension is a permission-minimal Manifest V3 package', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.permissions, undefined);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.content_scripts[0].js, ['content.js']);
  assert.equal(manifest.content_scripts[0].world, 'MAIN');
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
});

test('extension bundle is self-contained and Trusted Types compatible', () => {
  assert.match(content, /serverAbrStreamingUrl/);
  assert.match(content, /Muxing locally/);
  assert.doesNotMatch(content, /\.innerHTML\s*=/);
  assert.doesNotMatch(content, /insertAdjacentHTML\s*\(/);
  assert.doesNotMatch(content, /import\s+.*from\s+["']/);
});

test('extension reuses YouTube download UI and ships an optimized bundle', async () => {
  const uiSource = await readFile(resolve(process.cwd(), 'src/ui.ts'), 'utf8');
  const buildSource = await readFile(resolve(process.cwd(), 'scripts/build-extension.mjs'), 'utf8');
  assert.match(uiSource, /ytd-download-button-renderer/);
  assert.doesNotMatch(uiSource, /yt-local-download-fallback/);
  assert.doesNotMatch(uiSource, /new MutationObserver/);
  assert.match(uiSource, /tabindex: '-1'/);
  assert.match(uiSource, /\.focus\(\{ preventScroll: true \}\)/);
  assert.match(uiSource, /addEventListener\('wheel'/);
  assert.match(buildSource, /minify: true/);
  assert.match(buildSource, /treeShaking: true/);
  assert.ok(content.length < 450_000, `expected optimized content.js; got ${content.length} bytes`);
});

test('format choices preserve exact YouTube video encodes and expose diagnostics', async () => {
  const playerSource = await readFile(resolve(process.cwd(), 'src/player-data.ts'), 'utf8');
  const downloaderSource = await readFile(resolve(process.cwd(), 'src/downloader.ts'), 'utf8');
  const uiSource = await readFile(resolve(process.cwd(), 'src/ui.ts'), 'utf8');
  assert.match(playerSource, /const key = `\$\{video\.itag\}:\$\{video\.xtags \|\| ''\}`/);
  assert.match(playerSource, /fpsDetail/);
  assert.match(playerSource, /captured\.sabrUrlByVideoId\.get\(videoId\) \|\| streamingData\.serverAbrStreamingUrl/);
  assert.match(downloaderSource, /SABR request/);
  assert.match(downloaderSource, /formatBytes\(receivedBytes\)/);
  assert.match(uiSource, /role: 'alert'/);
  assert.match(uiSource, /aria-live': 'assertive'/);
  assert.match(uiSource, /scrollIntoView/);
  assert.doesNotMatch(uiSource, /Select a quality/);
  assert.match(uiSource, /scrollToProgressPending/);
  assert.ok(uiSource.indexOf("data-ytld-progress-wrap") < uiSource.indexOf("data-ytld-error"));
  assert.match(uiSource, /ytldVideoItag/);
  assert.match(uiSource, /activeController\.signal\.aborted/);
  assert.match(uiSource, /if \(!activeController\.signal\.aborted\) setProgress/);
  assert.match(uiSource, /sabr\\\.malformed_config/);
});

test('video muxes embed best-effort YouTube artwork without changing audio-only downloads', async () => {
  const playerSource = await readFile(resolve(process.cwd(), 'src/player-data.ts'), 'utf8');
  const downloaderSource = await readFile(resolve(process.cwd(), 'src/downloader.ts'), 'utf8');
  assert.match(playerSource, /thumbnailUrls/);
  assert.match(playerSource, /maxresdefault\.jpg/);
  assert.match(downloaderSource, /fetchVideoThumbnail/);
  assert.match(downloaderSource, /kind: 'coverFront'/);
  assert.match(downloaderSource, /images: thumbnail \? \[thumbnail\] : undefined/);
  assert.ok(
    downloaderSource.indexOf("if (plan.kind === 'audio')") < downloaderSource.indexOf('fetchVideoThumbnail(context'),
    'audio-only downloads must return before thumbnail fetching',
  );
});

test('music responses expose browser-only audio downloads above video qualities', async () => {
  const playerSource = await readFile(resolve(process.cwd(), 'src/player-data.ts'), 'utf8');
  const downloaderSource = await readFile(resolve(process.cwd(), 'src/downloader.ts'), 'utf8');
  const uiSource = await readFile(resolve(process.cwd(), 'src/ui.ts'), 'utf8');
  assert.match(playerSource, /function isMusicResponse/);
  assert.match(playerSource, /kind: 'audio'/);
  assert.match(playerSource, /format\.isDrc/);
  assert.match(downloaderSource, /EnabledTrackTypes\.AUDIO_ONLY/);
  assert.match(downloaderSource, /Downloading audio/);
  assert.ok(uiSource.indexOf("appendGroup('Audio only'") < uiSource.indexOf("appendGroup(audioPlans.length ? 'Video'"));
});

test('format choices respect active h264ify-family video preferences', async () => {
  const playerSource = await readFile(resolve(process.cwd(), 'src/player-data.ts'), 'utf8');
  assert.match(playerSource, /function h264ifyPreferences/);
  assert.match(playerSource, /checkerSource\.includes\('enhanced-h264ify-block_'\)/);
  assert.match(playerSource, /checkerSource\.includes\('h264ify-block_60fps'\)/);
  assert.match(playerSource, /blockedVideoTokens: \['webm', 'vp8', 'vp9', 'av01'\]/);
  assert.match(playerSource, /preferences\.blockHighFrameRate && fpsOf\(format\) > 30/);
  assert.match(playerSource, /const videos = allVideos\.filter\(\(format\) => !isBlockedVideo/);
});

test('enhanced-h264ify audio blocks do not hide music audio-only choices', async () => {
  const playerSource = await readFile(resolve(process.cwd(), 'src/player-data.ts'), 'utf8');
  assert.match(playerSource, /enhanced-h264ify-block_opus/);
  assert.match(playerSource, /enhanced-h264ify-block_mp4a/);
  assert.match(playerSource, /const videoAudio = allAudio\.filter\(\(format\) => !isBlockedAudio/);
  assert.match(playerSource, /const bestAudio = \[\.\.\.allAudio\]/);
  assert.match(playerSource, /const companionVideo = allVideos\.find/);
});

test('fractional device scale is encoded in the protobuf float field', () => {
  assert.doesNotMatch(content, /screenPixelDensity:\s*devicePixelRatio/);
  assert.match(content, /screenDensityFloat:/);
  assert.doesNotThrow(() => StreamerContext_ClientInfo.encode({
    clientName: 1,
    screenWidthPoints: 3840,
    screenHeightPoints: 2160,
    screenDensityFloat: 2.5,
  }).finish());
});

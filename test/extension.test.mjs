import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { StreamerContext_ClientInfo } from '../node_modules/googlevideo/dist/protos/generated/video_streaming/streamer_context.js';

const extensionRoot = resolve(process.cwd(), '../../outputs/youtube-local-downloader-extension');
const manifest = JSON.parse(await readFile(resolve(extensionRoot, 'manifest.json'), 'utf8'));
const content = await readFile(resolve(extensionRoot, 'content.js'), 'utf8');
const notificationBridge = await readFile(resolve(extensionRoot, 'notification-bridge.js'), 'utf8');
const background = await readFile(resolve(extensionRoot, 'background.js'), 'utf8');

test('extension is a permission-minimal Manifest V3 package', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['notifications', 'storage']);
  assert.deepEqual(manifest.host_permissions, [
    'https://api.github.com/*',
    'https://o4512046378254336.ingest.us.sentry.io/*',
  ]);
  assert.deepEqual(manifest.content_scripts[0].js, ['content.js']);
  assert.equal(manifest.content_scripts[0].world, 'MAIN');
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.deepEqual(manifest.content_scripts[1].js, ['notification-bridge.js']);
  assert.equal(manifest.content_scripts[1].world, 'ISOLATED');
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.match(notificationBridge, /chrome\.runtime\.sendMessage/);
  assert.match(notificationBridge, /videoTitle/);
  assert.match(notificationBridge, /ydown:check-for-updates:v1/);
  assert.match(notificationBridge, /ydown:enabled:v1/);
  assert.doesNotMatch(notificationBridge, /^chrome\.runtime\.sendMessage\(\{ type: CHECK_FOR_UPDATES_MESSAGE/m);
  assert.match(notificationBridge, /ydown:download-failure:v1/);
  assert.match(background, /chrome\.notifications\.create/);
  assert.match(background, /has downloaded succesfully/);
  assert.match(background, /icon\.png/);
  assert.match(background, /Could not show completion notification/);
  assert.match(background, /api\.github\.com\/repos\/subby2006\/ydown\/releases/);
  assert.match(background, /lastNotifiedReleaseTag/);
  assert.match(background, /UPDATE_CHECK_INTERVAL_MS/);
  assert.match(background, /chrome\.runtime\.getManifest\(\)\.version/);
  assert.match(
  background,
  /CURRENT_BUILD_ID = '(?:dev|\d+\.\d+)'/,
  );
  assert.match(background, /CURRENT_BUILD_TIME = '\d{4}-\d{2}-\d{2}T/);
  assert.match(background, /releaseTime > buildTime/);
  assert.match(background, /url\.hostname === 'youtube\.com'/);
  assert.match(background, /chrome\.tabs\.create/);
  assert.match(background, /application\/x-sentry-envelope/);
  assert.match(background, /ydown\.sentry-envelope/);
  assert.match(background, /isOfflineFailureMessage/);
  assert.match(background, /mechanism: \{ type: 'ydown\.download', handled: true \}/);
  assert.match(background, /video_id: videoId/);
  assert.match(background, /logged_in: loggedIn/);
  assert.match(background, /sabr_response: sabrResponse/);
  assert.match(background, /\[URL redacted\]/);
  assert.doesNotMatch(background, /__YDOWN_SENTRY_DSN__/);
  assert.doesNotMatch(background, /ipinfo|ip_type/i);
});

test('extension bundle is self-contained and Trusted Types compatible', () => {
  assert.match(content, /serverAbrStreamingUrl/);
  assert.match(content, /Muxing locally/);
  assert.doesNotMatch(content, /\.innerHTML\s*=/);
  assert.doesNotMatch(content, /insertAdjacentHTML\s*\(/);
  assert.doesNotMatch(content, /import\s+.*from\s+["']/);
});

test('Sentry reporting redacts URLs and skips offline download failures', async () => {
  const source = await readFile(resolve(process.cwd(), 'extension/background.js'), 'utf8');
  const calls = [];
  let onMessage;
  const chrome = {
    runtime: {
      getManifest: () => ({ version: '0.5.2' }),
      onMessage: { addListener: (listener) => { onMessage = listener; } },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    notifications: {
      create: async () => {},
      onClicked: { addListener: () => {} },
    },
    tabs: { create: async () => {} },
  };
  const runnable = source
    .replaceAll('__YDOWN_BUILD_ID__', 'test')
    .replaceAll('__YDOWN_BUILD_TIME__', '2026-09-07T00:00:00.000Z')
    .replaceAll(
      '__YDOWN_SENTRY_DSN__',
      'https://public@example.ingest.us.sentry.io/123',
    );
  runInNewContext(runnable, {
    chrome,
    console,
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true };
    },
    URL,
  });
  assert.equal(typeof onMessage, 'function');
  const sender = { tab: { url: 'https://www.youtube.com/watch?v=test' } };
  onMessage({
    type: 'ydown:download-failure:v1',
    errorName: 'SabrError',
    errorType: 'SabrError',
    errorMessage: 'Failed at https://rr1.googlevideo.com/videoplayback?pot=secretToken&sig=secretSignature',
    stack: 'SabrError at https://www.youtube.com/watch?v=privateVideo',
    videoId: 'dQw4w9WgXcQ',
    occurredAt: '2026-09-07T12:34:56.000Z',
    loggedIn: true,
    sabrResponse: {
      requestId: 4,
      status: 403,
      statusText: 'Forbidden',
      contentType: 'application/vnd.yt-ump',
      elapsedMs: 125,
      protectionStatus: 3,
      sabrErrorType: 'sabr.malformed_config',
      sabrErrorCode: 'INVALID_ARGUMENT',
    },
    phase: 'downloading',
    formatKind: 'video',
    container: 'mp4',
    videoItag: 137,
    audioItag: 140,
    online: true,
  }, sender);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/123\/envelope\/$/);
  assert.match(calls[0].options.body, /\[URL redacted\]/);
  assert.match(calls[0].options.body, /"video_id":"dQw4w9WgXcQ"/);
  assert.match(calls[0].options.body, /"logged_in":"true"/);
  assert.match(calls[0].options.body, /"occurred_at":"2026-09-07T12:34:56\.000Z"/);
  assert.match(calls[0].options.body, /"sabrErrorType":"sabr\.malformed_config"/);
  assert.doesNotMatch(calls[0].options.body, /secretToken|secretSignature|privateVideo/);

  onMessage({
    type: 'ydown:download-failure:v1',
    errorName: 'TypeError',
    errorMessage: 'Failed to fetch',
    online: false,
  }, sender);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.equal(calls.length, 1);
});

test('extension reuses YouTube download UI and ships an optimized bundle', async () => {
  const uiSource = await readFile(resolve(process.cwd(), 'src/ui.ts'), 'utf8');
  const mainSource = await readFile(resolve(process.cwd(), 'src/main.ts'), 'utf8');
  const premiumSource = await readFile(resolve(process.cwd(), 'src/premium.ts'), 'utf8');
  const buildSource = await readFile(resolve(process.cwd(), 'scripts/build-extension.mjs'), 'utf8');
  assert.match(premiumSource, /YOUTUBE_PREMIUM_LOGO/);
  assert.match(premiumSource, /ytInitialData/);
  assert.match(premiumSource, /DOMContentLoaded/);
  assert.match(mainSource, /if \(premium\)/);
  assert.ok(
    mainSource.indexOf('if (premium)') < mainSource.indexOf('installNetworkCapture()'),
    'Premium gating must happen before network interception is installed',
  );
  assert.match(mainSource, /ydown:enabled:v1/);
  assert.match(uiSource, /ytd-download-button-renderer/);
  assert.match(uiSource, /downloadContext = getPlayerContext\(\)/);
  assert.match(uiSource, /const refreshedPlan = downloadContext\.plans\.find/);
  assert.doesNotMatch(uiSource, /yt-local-download-fallback/);
  assert.match(uiSource, /pageManagerObserver\.observe\(pageManager/);
  assert.match(uiSource, /querySelectorAll\(':scope > ytd-browse'\)/);
  assert.match(uiSource, /attributeFilter: \['hidden'\]/);
  assert.match(uiSource, /childList: true/);
  assert.doesNotMatch(uiSource, /subtree: true/);
  assert.match(uiSource, /activePageHostObserver\.observe\(host, \{ childList: true \}\)/);
  assert.match(uiSource, /!ydownPage\?\.isConnected \|\| ydownPage\.parentElement !== host/);
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
  const buildSource = await readFile(resolve(process.cwd(), 'scripts/build-extension.mjs'), 'utf8');
  assert.match(playerSource, /const key = `\$\{video\.itag\}:\$\{video\.xtags \|\| ''\}`/);
  assert.match(playerSource, /fpsDetail/);
  assert.match(playerSource, /const capturedSabrUrl = captured\.sabrUrlByVideoId\.get\(videoId\)/);
  assert.match(playerSource, /serverAbrStreamingUrl,/);
  assert.match(playerSource, /videoPlaybackUstreamerConfig,/);
  assert.match(playerSource, /poToken: poToken \|\| null/);
  assert.match(playerSource, /const poToken = playerRequestPoToken \|\| nativeSabrPoToken/);
  assert.match(playerSource, /playerRequestPoToken\s*\? 'captured-player-request'/);
  assert.match(playerSource, /Sensitive console-only diagnostics/);
  assert.match(playerSource, /VideoPlaybackAbrRequest\.decode\(bytes\)/);
  assert.match(playerSource, /nativeSabrConfigByVideoId\.get\(videoId\)/);
  assert.match(playerSource, /nativeSabrPoTokenByVideoId\.get\(videoId\)/);
  assert.match(playerSource, /nativeSabrBodyDiagnostics/);
  assert.match(playerSource, /JSON\.stringify\(details\)/);
  assert.doesNotMatch(background, /videoPlaybackUstreamerConfig|serverAbrStreamingUrl|poToken/);
  assert.match(downloaderSource, /SABR request/);
  assert.match(downloaderSource, /__YDOWN_BROWSER_STORAGE_ONLY__/);
  assert.match(buildSource, /process\.argv\.includes\('--diagnostic-storage'\)/);
  assert.match(buildSource, /__YDOWN_BROWSER_STORAGE_ONLY__: String\(diagnosticStorage\)/);
  assert.match(buildSource, /youtube-local-downloader-extension-diagnostic/);
  assert.doesNotMatch(content, /ydown-diagnostic-downloads/);
  assert.match(downloaderSource, /const SABR_PLAYBACK_RATE = 2/);
  assert.match(downloaderSource, /VideoPlaybackAbrRequest\.decode\(init\.body\)/);
  assert.match(downloaderSource, /request\.clientAbrState\.playbackRate = SABR_PLAYBACK_RATE/);
  assert.equal(
    [...downloaderSource.matchAll(/browserFetch\(input, withSabrPlaybackRate\(init\)\)/g)].length,
    2,
    'both audio-only and video SABR requests must report 2x playback',
  );
  assert.match(downloaderSource, /attachSabrResponse/);
  assert.match(downloaderSource, /contentType: \(response\.headers\.get\('content-type'\)/);
  assert.match(downloaderSource, /sabrErrorType/);
  assert.match(downloaderSource, /formatBytes\(receivedBytes\)/);
  assert.match(uiSource, /role: 'alert'/);
  assert.match(uiSource, /aria-live': 'assertive'/);
  assert.match(uiSource, /scrollIntoView/);
  assert.doesNotMatch(uiSource, /Select a quality/);
  assert.match(uiSource, /scrollToProgressPending/);
  assert.match(uiSource, /data-ytld-hide/);
  assert.match(uiSource, /if \(!context \|\| running\) return;/);
  assert.match(uiSource, /ydown:download-complete:v1/);
  assert.match(uiSource, /ydown:download-failure:v1/);
  assert.match(uiSource, /function isOfflineFailure/);
  assert.match(uiSource, /reportDownloadFailure\(error, downloadContext, plan, currentPhase\)/);
  assert.match(uiSource, /videoId: downloadContext\.videoId/);
  assert.match(uiSource, /loggedIn: loggedInStatus\(\)/);
  assert.match(uiSource, /sabrResponse: sabrResponseForTelemetry\(error\)/);
  assert.match(uiSource, /\[URL redacted\]/);
  assert.match(uiSource, /location\.pathname === '\/feed\/downloads'/);
  assert.match(uiSource, /location\.pathname === '\/account_downloads'/);
  assert.match(uiSource, /\.ytld-settings-host > :not\(#ytld-page\):not\(ytd-settings-sidebar-renderer\)/);
  assert.match(uiSource, /host\.classList\.add\(isManager \? 'ytld-manager-host' : 'ytld-settings-host'\)/);
  assert.match(uiSource, /Work in progress/);
  assert.match(uiSource, /single-transfer window/);
  assert.match(uiSource, /href: '\/account_downloads'/);
  assert.match(uiSource, /Strip non-music sections from music downloads/);
  assert.match(uiSource, /ydown:strip-non-music-sections/);
  assert.match(uiSource, /role: 'switch'/);
  assert.match(uiSource, /Not implemented yet/);
  assert.doesNotMatch(downloaderSource, /strip-non-music-sections|SponsorBlock/);
  assert.doesNotMatch(uiSource, /MAX_CONCURRENT_DOWNLOADS/);
  assert.doesNotMatch(uiSource, /activeDownloads/);
  assert.doesNotMatch(uiSource, /Recent downloads/);
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

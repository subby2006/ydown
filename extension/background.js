const DOWNLOAD_COMPLETE_MESSAGE = 'ydown:download-complete:v1';
const DOWNLOAD_FAILURE_MESSAGE = 'ydown:download-failure:v1';
const CHECK_FOR_UPDATES_MESSAGE = 'ydown:check-for-updates:v1';
const RELEASES_API_URL = 'https://api.github.com/repos/subby2006/ydown/releases?per_page=20';
const RELEASES_PAGE_URL = 'https://github.com/subby2006/ydown/releases';
const CURRENT_BUILD_ID = '__YDOWN_BUILD_ID__';
const CURRENT_BUILD_TIME = '__YDOWN_BUILD_TIME__';
const SENTRY_DSN = '__YDOWN_SENTRY_DSN__';
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;
const MIN_NOTIFICATION_INTERVAL_MS = 5_000;
let lastNotificationAt = 0;
let updateCheckPromise = null;

function isOfflineFailureMessage(message) {
  return message?.online === false
    || /err_internet_disconnected|err_network_changed|network connection was lost|internet connection.*lost|\boffline\b|dns_probe|econnreset|enotfound|socket hang up/i.test(message?.errorMessage || '');
}

function sentryEnvelopeUrl() {
  if (!SENTRY_DSN) return null;
  try {
    const dsn = new URL(SENTRY_DSN);
    const projectId = dsn.pathname.split('/').filter(Boolean).at(-1);
    if (dsn.protocol !== 'https:' || !dsn.username || !projectId) return null;
    return `${dsn.protocol}//${dsn.host}/api/${projectId}/envelope/`;
  } catch {
    return null;
  }
}

function redactSentryText(value, limit) {
  return String(value || '')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL redacted]')
    .replace(/[?&](?:pot|token|signature|sig|key)=[^\s&]+/gi, '$1=[redacted]')
    .slice(0, limit);
}

function safeSabrResponse(value) {
  if (!value || typeof value !== 'object') return null;
  const summary = {};
  for (const key of ['requestId', 'status', 'elapsedMs', 'protectionStatus']) {
    const number = Number(value[key]);
    if (Number.isFinite(number)) summary[key] = number;
  }
  for (const [key, limit] of [
    ['statusText', 120],
    ['contentType', 160],
    ['sabrErrorType', 120],
    ['sabrErrorCode', 120],
  ]) {
    if (typeof value[key] === 'string') summary[key] = redactSentryText(value[key], limit);
  }
  return Object.keys(summary).length ? summary : null;
}

async function sendDownloadFailureToSentry(message) {
  if (isOfflineFailureMessage(message)) return;
  const endpoint = sentryEnvelopeUrl();
  if (!endpoint) return;
  const eventId = crypto.randomUUID().replaceAll('-', '');
  const manifest = chrome.runtime.getManifest();
  const errorName = redactSentryText(message.errorName || 'Error', 120);
  const errorType = redactSentryText(message.errorType || errorName, 120);
  const errorMessage = redactSentryText(message.errorMessage || 'Unknown download failure', 2_000);
  const videoId = redactSentryText(message.videoId || 'unknown', 32);
  const loggedIn = typeof message.loggedIn === 'boolean' ? String(message.loggedIn) : 'unknown';
  const occurredAtMs = Date.parse(message.occurredAt || '');
  const occurredAt = Number.isFinite(occurredAtMs) ? new Date(occurredAtMs).toISOString() : new Date().toISOString();
  const sabrResponse = safeSabrResponse(message.sabrResponse);
  const event = {
    event_id: eventId,
    timestamp: Date.parse(occurredAt) / 1_000,
    platform: 'javascript',
    level: 'error',
    logger: 'ydown.download',
    release: `ydown@${manifest.version}+${CURRENT_BUILD_ID}`,
    environment: CURRENT_BUILD_ID === 'dev' ? 'development' : 'production',
    message: `Download failed: ${errorMessage}`,
    exception: {
      values: [{
        type: errorName,
        value: errorMessage,
        mechanism: { type: 'ydown.download', handled: true },
      }],
    },
    tags: {
      phase: redactSentryText(message.phase || 'unknown', 40),
      format_kind: redactSentryText(message.formatKind || 'unknown', 20),
      container: redactSentryText(message.container || 'unknown', 20),
      video_itag: String(Number(message.videoItag) || 0),
      audio_itag: String(Number(message.audioItag) || 0),
      video_id: videoId,
      error_type: errorType,
      logged_in: loggedIn,
      build: CURRENT_BUILD_ID,
    },
    extra: {
      occurred_at: occurredAt,
      sabr_response: sabrResponse,
      stack: redactSentryText(message.stack || '', 8_000),
    },
  };
  const envelope = [
    JSON.stringify({
      event_id: eventId,
      dsn: SENTRY_DSN,
      sent_at: new Date().toISOString(),
      sdk: { name: 'ydown.sentry-envelope', version: '1.0.0' },
    }),
    JSON.stringify({ type: 'event', content_type: 'application/json' }),
    JSON.stringify(event),
  ].join('\n');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-sentry-envelope' },
    body: envelope,
  });
  if (!response.ok) throw new Error(`Sentry rejected the event with HTTP ${response.status}.`);
}

function compareNumberLists(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function semanticVersion(tagName) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(tagName);
  return match ? match.slice(1, 4).map(Number) : null;
}

function buildVersion(tagName) {
  const match = /^build-(\d+)\.(\d+)-/.exec(tagName);
  return match ? match.slice(1, 3).map(Number) : null;
}

function isYouTubeSender(sender) {
  try {
    const url = new URL(sender.tab?.url || '');
    return url.protocol === 'https:' && (url.hostname === 'youtube.com' || url.hostname === 'www.youtube.com');
  } catch {
    return false;
  }
}

function isNewerRelease(release) {
  if (!release || release.draft || typeof release.tag_name !== 'string') return false;
  const releaseSemver = semanticVersion(release.tag_name);
  if (releaseSemver) {
    const installedSemver = chrome.runtime.getManifest().version.split('.').map(Number);
    return compareNumberLists(releaseSemver, installedSemver) > 0;
  }
  const releaseBuild = buildVersion(release.tag_name);
  if (!releaseBuild) return false;
  if (CURRENT_BUILD_ID === 'dev') {
    const releaseTime = Date.parse(release.published_at || '');
    const buildTime = Date.parse(CURRENT_BUILD_TIME);
    return Number.isFinite(releaseTime) && Number.isFinite(buildTime) && releaseTime > buildTime;
  }
  const installedBuild = CURRENT_BUILD_ID.split('.').map(Number);
  return compareNumberLists(releaseBuild, installedBuild) > 0;
}

async function checkForUpdates() {
  const now = Date.now();
  const stored = await chrome.storage.local.get(['lastUpdateCheckAt', 'lastNotifiedReleaseTag']);
  if (now - Number(stored.lastUpdateCheckAt || 0) < UPDATE_CHECK_INTERVAL_MS) return;
  await chrome.storage.local.set({ lastUpdateCheckAt: now });

  const response = await fetch(RELEASES_API_URL, {
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub releases request failed with HTTP ${response.status}.`);
  const releases = await response.json();
  if (!Array.isArray(releases)) throw new Error('GitHub returned an invalid releases response.');
  const update = releases.find(isNewerRelease);
  if (!update || update.tag_name === stored.lastNotifiedReleaseTag) return;

  const label = String(update.name || update.tag_name).trim().slice(0, 180);
  const notificationId = `ydown-update-${update.tag_name}`.replace(/[^a-z0-9_.-]/gi, '-').slice(0, 200);
  await chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icon.png',
    title: 'ydown update available',
    message: `${label} is available on GitHub.`,
    priority: 1,
  });
  await chrome.storage.local.set({ lastNotifiedReleaseTag: update.tag_name });
}

function scheduleUpdateCheck() {
  if (updateCheckPromise) return;
  updateCheckPromise = checkForUpdates()
    .catch((error) => console.warn('[ydown] Could not check GitHub releases.', error))
    .finally(() => { updateCheckPromise = null; });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!isYouTubeSender(sender)) return;
  if (message?.type === CHECK_FOR_UPDATES_MESSAGE) {
    scheduleUpdateCheck();
    return;
  }
  if (message?.type === DOWNLOAD_FAILURE_MESSAGE) {
    sendDownloadFailureToSentry(message).catch((error) => {
      console.warn('[ydown] Could not report the download failure.', error);
    });
    return;
  }
  if (message?.type !== DOWNLOAD_COMPLETE_MESSAGE || typeof message.videoTitle !== 'string') return;

  const now = Date.now();
  if (now - lastNotificationAt < MIN_NOTIFICATION_INTERVAL_MS) return;
  lastNotificationAt = now;

  const videoTitle = message.videoTitle.trim().slice(0, 200) || 'Your video';
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon.png',
    title: 'Download finished',
    message: `${videoTitle} has downloaded succesfully`,
    priority: 1,
  }).catch((error) => console.error('[ydown] Could not show completion notification.', error));
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith('ydown-update-')) return;
  chrome.tabs.create({ url: RELEASES_PAGE_URL }).catch((error) => {
    console.warn('[ydown] Could not open the releases page.', error);
  });
});

const DOWNLOAD_COMPLETE_MESSAGE = 'ydown:download-complete:v1';
const DOWNLOAD_FAILURE_MESSAGE = 'ydown:download-failure:v1';
const CHECK_FOR_UPDATES_MESSAGE = 'ydown:check-for-updates:v1';
const ENABLED_MESSAGE = 'ydown:enabled:v1';

let updateCheckSent = false;

function normalizeSabrResponse(value) {
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
    if (typeof value[key] === 'string') summary[key] = value[key].slice(0, limit);
  }
  return Object.keys(summary).length ? summary : null;
}

window.addEventListener('message', (event) => {
  if (
    event.source === window
    && event.origin === location.origin
    && event.data?.type === ENABLED_MESSAGE
  ) {
    if (!updateCheckSent) {
      updateCheckSent = true;
      chrome.runtime.sendMessage({ type: CHECK_FOR_UPDATES_MESSAGE }).catch(() => {});
    }
    return;
  }
  if (
    event.source === window
    && event.origin === location.origin
    && event.data?.type === DOWNLOAD_FAILURE_MESSAGE
  ) {
    chrome.runtime.sendMessage({
      type: DOWNLOAD_FAILURE_MESSAGE,
      errorName: String(event.data.errorName || 'Error').slice(0, 120),
      errorType: String(event.data.errorType || event.data.errorName || 'Error').slice(0, 120),
      errorMessage: String(event.data.errorMessage || 'Unknown download failure').slice(0, 2_000),
      stack: String(event.data.stack || '').slice(0, 8_000),
      videoId: String(event.data.videoId || '').slice(0, 32),
      occurredAt: String(event.data.occurredAt || '').slice(0, 40),
      loggedIn: typeof event.data.loggedIn === 'boolean' ? event.data.loggedIn : null,
      sabrResponse: normalizeSabrResponse(event.data.sabrResponse),
      phase: String(event.data.phase || 'unknown').slice(0, 40),
      formatKind: String(event.data.formatKind || 'unknown').slice(0, 20),
      container: String(event.data.container || 'unknown').slice(0, 20),
      videoItag: Number(event.data.videoItag) || 0,
      audioItag: Number(event.data.audioItag) || 0,
      online: event.data.online !== false,
    }).catch(() => {});
    return;
  }
  if (
    event.source !== window
    || event.origin !== location.origin
    || event.data?.type !== DOWNLOAD_COMPLETE_MESSAGE
    || typeof event.data.videoTitle !== 'string'
  ) return;

  chrome.runtime.sendMessage({
    type: DOWNLOAD_COMPLETE_MESSAGE,
    videoTitle: event.data.videoTitle.slice(0, 200),
  }).catch(() => {});
});

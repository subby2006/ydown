import { downloadAndMux, usesBrowserStorageDestination } from './downloader';
import { getPlayerContext } from './player-data';
import type { DownloadPlan, PlayerContext, ProgressUpdate } from './types';

const NATIVE_DOWNLOAD_SELECTOR = [
  'ytd-download-button-renderer',
  'ytd-menu-service-item-download-renderer',
].join(',');
const DOWNLOAD_COMPLETE_MESSAGE = 'ydown:download-complete:v1';
const DOWNLOAD_FAILURE_MESSAGE = 'ydown:download-failure:v1';

const CSS = `
#yt-local-downloader-overlay {
  position: fixed; inset: 0; z-index: 2200000000; display: grid; place-items: center;
  padding: 20px; background: rgba(0,0,0,.62); font-family: Roboto, Arial, sans-serif;
}
#yt-local-downloader-overlay[hidden] { display: none; }
#yt-local-downloader-dialog {
  width: min(560px, calc(100vw - 32px)); max-height: min(720px, calc(100vh - 32px));
  overflow: auto; color: var(--yt-spec-text-primary, #0f0f0f);
  background: var(--yt-spec-general-background-a, #fff); border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0,0,0,.38); font-size: 14px; outline: none;
  overscroll-behavior: contain; scrollbar-gutter: stable;
}
.ytld-head { display:flex; align-items:center; gap:12px; padding:20px 20px 12px; }
.ytld-head h2 { flex:1; margin:0; font-size:20px; font-weight:500; line-height:28px; }
.ytld-icon-button { border:0; border-radius:50%; width:40px; height:40px; display:grid; place-items:center;
  color:inherit; background:transparent; cursor:pointer; }
.ytld-icon-button:hover { background:var(--yt-spec-badge-chip-background, rgba(0,0,0,.08)); }
.ytld-body { padding:0 20px 20px; }
.ytld-list { display:grid; gap:8px; }
.ytld-group-heading { margin:8px 2px 2px; font-size:14px; font-weight:500; line-height:20px; }
.ytld-group-heading:not(:first-child) { margin-top:18px; }
.ytld-quality { width:100%; box-sizing:border-box; display:flex; align-items:center; gap:16px; text-align:left;
  color:inherit; background:transparent; border:1px solid var(--yt-spec-10-percent-layer, rgba(0,0,0,.14));
  border-radius:10px; padding:12px 14px; cursor:pointer; }
.ytld-quality:hover { background:var(--yt-spec-badge-chip-background, rgba(0,0,0,.06)); }
.ytld-quality:disabled { cursor:default; opacity:.45; }
.ytld-quality strong { min-width:72px; font-size:16px; font-weight:500; }
.ytld-quality span { flex:1; color:var(--yt-spec-text-secondary, #606060); }
.ytld-progress-wrap { margin-top:8px; padding:16px 0 4px; }
.ytld-progress-label { margin-bottom:10px; line-height:20px; }
.ytld-progress { height:4px; overflow:hidden; border-radius:4px; background:var(--yt-spec-10-percent-layer, rgba(0,0,0,.14)); }
.ytld-progress > div { height:100%; width:0; background:#065fd4; transition:width .12s linear; }
.ytld-progress.indeterminate > div { width:35%; animation:ytld-slide 1.15s infinite ease-in-out; }
@keyframes ytld-slide { from { transform:translateX(-110%); } to { transform:translateX(310%); } }
.ytld-error { margin:12px 0 4px; padding:12px; color:#c00; background:rgba(204,0,0,.08); border-radius:8px; line-height:20px; outline:none; }
.ytld-error strong, .ytld-error span { display:block; }
.ytld-error span { margin-top:4px; }
.ytld-error-detail { font-size:12px; opacity:.82; overflow-wrap:anywhere; }
.ytld-foot { margin:16px 0 0; color:var(--yt-spec-text-secondary, #606060); font-size:12px; line-height:17px; }
.ytld-actions { display:flex; justify-content:flex-end; gap:8px; padding-top:16px; }
.ytld-text-button { border:0; border-radius:18px; padding:9px 16px; color:#065fd4; background:transparent;
  font-weight:500; cursor:pointer; }
.ytld-text-button:hover { background:rgba(6,95,212,.1); }
html[dark] #yt-local-downloader-dialog { color:var(--yt-spec-text-primary, #f1f1f1); background:var(--yt-spec-general-background-a, #212121); }
#ytld-page { position:relative; z-index:1; display:block; align-self:stretch; width:100%; min-width:0;
  min-height:calc(100vh - 56px); box-sizing:border-box;
  padding:32px max(24px, calc((100% - 1120px) / 2)); color:var(--yt-spec-text-primary, #0f0f0f);
  background:var(--yt-spec-general-background-a, #fff); font:14px/20px Roboto,Arial,sans-serif; }
ytd-browse.ytld-manager-host > :not(#ytld-page) { display:none !important; }
ytd-browse.ytld-settings-host > :not(#ytld-page):not(ytd-settings-sidebar-renderer) { display:none !important; }
.ytld-manager-head { display:flex; align-items:center; gap:12px; margin-bottom:28px; }
.ytld-manager-head h1 { margin:0; font-size:28px; line-height:36px; font-weight:600; }
.ytld-manager-badge { padding:3px 9px; border-radius:12px; color:var(--yt-spec-text-secondary,#606060);
  background:var(--yt-spec-badge-chip-background,rgba(0,0,0,.08)); font-size:12px; font-weight:500; }
.ytld-manager-settings { margin-left:auto; display:inline-flex; align-items:center; gap:8px; padding:9px 14px;
  border-radius:18px; color:var(--yt-spec-text-primary,#0f0f0f); background:transparent;
  font-weight:500; text-decoration:none; }
.ytld-manager-settings:hover { background:var(--yt-spec-badge-chip-background,rgba(0,0,0,.08)); }
.ytld-manager-settings svg { width:20px; height:20px; }
.ytld-manager-wip { padding:24px; border-radius:12px; color:var(--yt-spec-text-secondary,#606060);
  background:var(--yt-spec-badge-chip-background,rgba(0,0,0,.05)); }
.ytld-settings-card { max-width:760px; border-top:1px solid var(--yt-spec-10-percent-layer,rgba(0,0,0,.14)); }
.ytld-settings-row { display:flex; align-items:center; gap:28px; padding:22px 0;
  border-bottom:1px solid var(--yt-spec-10-percent-layer,rgba(0,0,0,.14)); }
.ytld-settings-copy { flex:1; min-width:0; }
.ytld-settings-copy strong { display:block; font-size:16px; line-height:22px; font-weight:500; }
.ytld-settings-copy span { display:block; margin-top:5px; color:var(--yt-spec-text-secondary,#606060); }
.ytld-toggle { position:relative; flex:0 0 auto; width:36px; height:20px; padding:0; border:0;
  border-radius:10px; background:var(--yt-spec-icon-disabled,#909090); cursor:pointer; }
.ytld-toggle::after { content:''; position:absolute; top:2px; left:2px; width:16px; height:16px;
  border-radius:50%; background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.35); transition:transform .15s ease; }
.ytld-toggle[aria-checked='true'] { background:#065fd4; }
.ytld-toggle[aria-checked='true']::after { transform:translateX(16px); }
.ytld-toggle:focus-visible { outline:2px solid #065fd4; outline-offset:3px; }
`;

let overlay: HTMLElement | null = null;
let context: PlayerContext | null = null;
let controller: AbortController | null = null;
let running = false;
let returnFocusTo: HTMLElement | null = null;
let currentPhase: ProgressUpdate['phase'] = 'preparing';
let scrollToProgressPending = false;
let ydownPage: HTMLElement | null = null;
let pageManagerObserver: MutationObserver | null = null;
let observedPageManager: Element | null = null;
let activePageHostObserver: MutationObserver | null = null;
let observedActivePageHost: Element | null = null;
const STRIP_NON_MUSIC_SECTIONS_KEY = 'ydown:strip-non-music-sections';

function closeIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'm19 6.4-1.4-1.4L12 10.6 6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z');
  svg.append(path);
  return svg;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string; attrs?: Record<string, string> } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs || {})) node.setAttribute(name, value);
  return node;
}

function ensureStyles(): void {
  if (document.getElementById('yt-local-downloader-styles')) return;
  const style = document.createElement('style');
  style.id = 'yt-local-downloader-styles';
  style.textContent = CSS;
  (document.head || document.documentElement).append(style);
}

function settingsIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.08-.98l2.11-1.65-2-3.46-2.49 1a7.2 7.2 0 0 0-1.69-.98L15 3.25h-4l-.35 2.68c-.61.25-1.17.58-1.69.98l-2.49-1-2 3.46 2.11 1.65c-.05.32-.08.66-.08.98s.03.66.08.98l-2.11 1.65 2 3.46 2.49-1c.52.4 1.08.73 1.69.98L11 20.75h4l.35-2.68c.61-.25 1.17-.58 1.69-.98l2.49 1 2-3.46-2.1-1.65ZM13 15.5A3.5 3.5 0 1 1 13 8a3.5 3.5 0 0 1 0 7.5Z');
  svg.append(path);
  return svg;
}

function storedToggle(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

function setStoredToggle(key: string, enabled: boolean): void {
  try {
    localStorage.setItem(key, String(enabled));
  } catch {
    // The preference stays usable for this render if storage is unavailable.
  }
}

function managerContent(): HTMLElement[] {
  const head = element('header', { className: 'ytld-manager-head' });
  const settings = element('a', {
    className: 'ytld-manager-settings',
    attrs: { href: '/account_downloads', 'aria-label': 'ydown settings' },
  });
  settings.append(settingsIcon(), element('span', { text: 'Settings' }));
  head.append(
    element('h1', { text: 'Downloads' }),
    element('span', { className: 'ytld-manager-badge', text: 'Work in progress' }),
    settings,
  );
  return [
    head,
    element('div', {
      className: 'ytld-manager-wip',
      text: 'The ydown download manager is under development. Downloads continue to use the single-transfer window for now.',
    }),
  ];
}

function settingsContent(): HTMLElement[] {
  const head = element('header', { className: 'ytld-manager-head' });
  head.append(
    element('h1', { text: 'ydown settings' }),
    element('span', { className: 'ytld-manager-badge', text: 'Experimental' }),
  );

  const enabled = storedToggle(STRIP_NON_MUSIC_SECTIONS_KEY);
  const toggle = element('button', {
    className: 'ytld-toggle',
    attrs: {
      type: 'button',
      role: 'switch',
      'aria-label': 'Strip non-music sections from music downloads',
      'aria-checked': String(enabled),
    },
  });
  toggle.addEventListener('click', () => {
    const next = toggle.getAttribute('aria-checked') !== 'true';
    toggle.setAttribute('aria-checked', String(next));
    setStoredToggle(STRIP_NON_MUSIC_SECTIONS_KEY, next);
  });

  const copy = element('div', { className: 'ytld-settings-copy' });
  copy.append(
    element('strong', { text: 'Strip non-music sections from music downloads' }),
    element('span', {
      text: 'Not implemented yet. This will eventually use SponsorBlock music tags to remove non-music sections from eligible audio downloads.',
    }),
  );
  const row = element('div', { className: 'ytld-settings-row' });
  row.append(copy, toggle);
  const card = element('section', { className: 'ytld-settings-card', attrs: { 'aria-label': 'Download settings' } });
  card.append(row);
  return [head, card];
}

function renderYdownPage(): void {
  const isManager = location.pathname === '/feed/downloads';
  const isSettings = location.pathname === '/account_downloads';
  if (!isManager && !isSettings) {
    activePageHostObserver?.disconnect();
    activePageHostObserver = null;
    observedActivePageHost = null;
    ydownPage?.remove();
    ydownPage = null;
    document.querySelectorAll('.ytld-manager-host, .ytld-settings-host').forEach((node) => {
      node.classList.remove('ytld-manager-host', 'ytld-settings-host');
    });
    return;
  }
  ensureStyles();
  const host = document.querySelector<HTMLElement>('ytd-page-manager > ytd-browse:not([hidden])');
  if (!host) return;
  document.querySelectorAll('.ytld-manager-host, .ytld-settings-host').forEach((node) => {
    node.classList.remove('ytld-manager-host', 'ytld-settings-host');
  });
  host.classList.add(isManager ? 'ytld-manager-host' : 'ytld-settings-host');
  if (!ydownPage?.isConnected) ydownPage = element('main', { attrs: { id: 'ytld-page' } });
  if (ydownPage.parentElement !== host) host.append(ydownPage);
  observeActivePageHost(host);
  ydownPage.replaceChildren(...(isManager ? managerContent() : settingsContent()));
}

function observeActivePageHost(host: Element): void {
  if (observedActivePageHost === host && activePageHostObserver) return;
  activePageHostObserver?.disconnect();
  observedActivePageHost = host;
  activePageHostObserver = new MutationObserver(() => {
    if (!ydownPage?.isConnected || ydownPage.parentElement !== host) queueMicrotask(renderYdownPage);
  });
  activePageHostObserver.observe(host, { childList: true });
}

function observePageHostChanges(): void {
  const pageManager = document.querySelector('ytd-page-manager');
  if (!pageManager) return;
  if (observedPageManager !== pageManager || !pageManagerObserver) {
    pageManagerObserver?.disconnect();
    observedPageManager = pageManager;
    pageManagerObserver = new MutationObserver(() => queueMicrotask(() => {
      observePageHostChanges();
      renderYdownPage();
    }));
  }
  pageManagerObserver.observe(pageManager, { childList: true });
  pageManager.querySelectorAll(':scope > ytd-browse').forEach((browse) => {
    pageManagerObserver?.observe(browse, { attributes: true, attributeFilter: ['hidden'] });
  });
}

function ensureDialog(): HTMLElement {
  if (overlay?.isConnected) return overlay;
  ensureStyles();
  overlay = document.createElement('div');
  overlay.id = 'yt-local-downloader-overlay';
  overlay.hidden = true;

  const dialog = element('section', {
    attrs: {
      id: 'yt-local-downloader-dialog',
      role: 'dialog',
      tabindex: '-1',
      'aria-modal': 'true',
      'aria-labelledby': 'ytld-title',
    },
  });
  const header = element('header', { className: 'ytld-head' });
  const title = element('h2', { text: 'Download', attrs: { id: 'ytld-title' } });
  const closeButton = element('button', {
    className: 'ytld-icon-button',
    attrs: { type: 'button', 'data-ytld-close': '', 'aria-label': 'Close' },
  });
  closeButton.append(closeIcon());
  header.append(title, closeButton);

  const body = element('div', { className: 'ytld-body' });
  const list = element('div', { className: 'ytld-list', attrs: { 'data-ytld-list': '' } });
  const progressWrap = element('div', {
    className: 'ytld-progress-wrap',
    attrs: { 'data-ytld-progress-wrap': '', hidden: '' },
  });
  const progressLabel = element('div', {
    className: 'ytld-progress-label',
    attrs: { 'data-ytld-progress-label': '' },
  });
  const progress = element('div', { className: 'ytld-progress', attrs: { 'data-ytld-progress': '' } });
  progress.append(element('div'));
  progressWrap.append(progressLabel, progress);
  const error = element('div', {
    className: 'ytld-error',
    attrs: {
      'data-ytld-error': '',
      hidden: '',
      role: 'alert',
      'aria-live': 'assertive',
      tabindex: '-1',
    },
  });
  const foot = element('p', {
    className: 'ytld-foot',
    text: 'No media is sent to a third-party service. Keep this tab open and use downloads only where you have permission.',
  });
  const actions = element('div', { className: 'ytld-actions' });
  const hide = element('button', {
    className: 'ytld-text-button',
    text: 'Hide',
    attrs: { type: 'button', 'data-ytld-hide': '', hidden: '' },
  });
  const cancel = element('button', {
    className: 'ytld-text-button',
    text: 'Close',
    attrs: { type: 'button', 'data-ytld-cancel': '' },
  });
  actions.append(hide, cancel);
  body.append(list, progressWrap, error, foot, actions);
  dialog.append(header, body);
  overlay.append(dialog);
  document.documentElement.append(overlay);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay && !running) closeDialog();
  });
  overlay.addEventListener('wheel', (event) => {
    if (event.ctrlKey) return;
    const panel = overlay?.querySelector<HTMLElement>('#yt-local-downloader-dialog');
    if (!panel || panel.scrollHeight <= panel.clientHeight) return;
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? panel.clientHeight
        : 1;
    panel.scrollTop += event.deltaY * unit;
    event.preventDefault();
    event.stopPropagation();
  }, { passive: false });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && overlay && !overlay.hidden) closeOrHide();
  });
  return overlay;
}

function closeOrCancel(): void {
  if (running) {
    controller?.abort(new DOMException('Canceled by user', 'AbortError'));
    setProgress({ phase: 'preparing', label: 'Canceling…', fraction: null });
  } else {
    closeDialog();
  }
}

function closeOrHide(): void {
  if (running) hideDialog();
  else closeDialog();
}

function hideDialog(): void {
  if (!overlay) return;
  overlay.hidden = true;
  if (returnFocusTo?.isConnected) returnFocusTo.focus({ preventScroll: true });
  returnFocusTo = null;
}

function closeDialog(): void {
  if (running || !overlay) return;
  hideDialog();
  context = null;
}

function errorMessage(error: unknown): { message: string; detail?: string } {
  const original = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError') {
    return { message: 'The browser ran out of temporary storage. Free some disk space and try again.', detail: original };
  }
  if (name === 'NotAllowedError') {
    return { message: 'Chrome did not allow access to the chosen destination file.', detail: original };
  }
  if (/failed to fetch|networkerror|network request failed/i.test(original)) {
    return {
      message: 'A YouTube media request failed. The playback URL or token may have expired. Reload the video, play it briefly, and retry.',
      detail: original,
    };
  }
  if (/server returned (401|403|410)/i.test(original)) {
    return {
      message: 'YouTube rejected the media request. Reload the video, play it briefly, and retry with a fresh playback token.',
      detail: original,
    };
  }
  if (/sabr\.malformed_config/i.test(original)) {
    return {
      message: 'YouTube rejected the streaming session configuration. Reload the video, play it briefly, and retry so the extension can use a fresh matching session.',
      detail: original,
    };
  }
  return { message: original };
}

function setError(error: unknown): void {
  const node = ensureDialog().querySelector<HTMLElement>('[data-ytld-error]');
  if (!node) return;
  const { message, detail } = errorMessage(error);
  const phase = currentPhase === 'downloading'
    ? 'downloading the tracks'
    : currentPhase === 'muxing'
      ? 'muxing the local file'
      : 'preparing the download';
  node.replaceChildren(
    element('strong', { text: `Download failed while ${phase}.` }),
    element('span', { text: message }),
  );
  if (detail && detail !== message) {
    node.append(element('span', { className: 'ytld-error-detail', text: `Technical detail: ${detail}` }));
  }
  node.hidden = false;
  node.scrollIntoView({ block: 'end', behavior: 'smooth' });
  node.focus({ preventScroll: true });
  console.error('[YT Local Downloader] Download failed', error);
}

function clearError(): void {
  const node = ensureDialog().querySelector<HTMLElement>('[data-ytld-error]');
  if (node) node.hidden = true;
}

function isOfflineFailure(error: unknown): boolean {
  if (!navigator.onLine) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /err_internet_disconnected|err_network_changed|network connection was lost|internet connection.*lost|\boffline\b|dns_probe|econnreset|enotfound|socket hang up/i.test(message);
}

function redactFailureText(value: string, limit: number): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL redacted]')
    .replace(/[?&](?:pot|token|signature|sig|key)=[^\s&]+/gi, '$1=[redacted]')
    .slice(0, limit);
}

function sabrResponseForTelemetry(error: unknown): Record<string, string | number> | null {
  if (!(error instanceof Error) || !('sabrResponse' in error)) return null;
  const source = (error as Error & { sabrResponse?: Record<string, unknown> }).sabrResponse;
  if (!source || typeof source !== 'object') return null;
  const summary: Record<string, string | number> = {};
  for (const key of ['requestId', 'status', 'elapsedMs', 'protectionStatus'] as const) {
    const value = Number(source[key]);
    if (Number.isFinite(value)) summary[key] = value;
  }
  for (const [key, limit] of [
    ['statusText', 120],
    ['contentType', 160],
    ['sabrErrorType', 120],
    ['sabrErrorCode', 120],
  ] as const) {
    if (typeof source[key] === 'string') summary[key] = redactFailureText(source[key], limit);
  }
  return Object.keys(summary).length ? summary : null;
}

function loggedInStatus(): boolean | null {
  try {
    const value = window.ytcfg?.get?.('LOGGED_IN');
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

function reportDownloadFailure(
  error: unknown,
  downloadContext: PlayerContext,
  plan: DownloadPlan,
  phase: ProgressUpdate['phase'],
): void {
  if (isOfflineFailure(error)) return;
  const errorName = error instanceof Error ? error.name : 'Error';
  const errorMessage = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack || '' : '';
  window.postMessage({
    type: DOWNLOAD_FAILURE_MESSAGE,
    errorName: redactFailureText(errorName, 120),
    errorType: redactFailureText(errorName, 120),
    errorMessage: redactFailureText(errorMessage, 2_000),
    stack: redactFailureText(stack, 8_000),
    videoId: downloadContext.videoId.slice(0, 32),
    occurredAt: new Date().toISOString(),
    loggedIn: loggedInStatus(),
    sabrResponse: sabrResponseForTelemetry(error),
    phase,
    formatKind: plan.kind,
    container: plan.extension,
    videoItag: plan.video.itag,
    audioItag: plan.audio.itag,
    online: navigator.onLine,
  }, location.origin);
}

function setProgress(update: ProgressUpdate): void {
  currentPhase = update.phase;
  const root = ensureDialog();
  const wrap = root.querySelector<HTMLElement>('[data-ytld-progress-wrap]');
  const label = root.querySelector<HTMLElement>('[data-ytld-progress-label]');
  const bar = root.querySelector<HTMLElement>('[data-ytld-progress]');
  const fill = bar?.firstElementChild as HTMLElement | null;
  if (!wrap || !label || !bar || !fill) return;
  wrap.hidden = false;
  label.textContent = update.label;
  bar.classList.toggle('indeterminate', update.fraction === null);
  fill.style.width = update.fraction === null ? '' : `${Math.max(0, Math.min(1, update.fraction)) * 100}%`;
  if (scrollToProgressPending) {
    scrollToProgressPending = false;
    requestAnimationFrame(() => {
      const panel = root.querySelector<HTMLElement>('#yt-local-downloader-dialog');
      panel?.scrollTo({ top: panel.scrollHeight, behavior: 'smooth' });
    });
  }
}

function setRunning(value: boolean): void {
  running = value;
  ensureDialog().querySelectorAll<HTMLButtonElement>('.ytld-quality').forEach((button) => {
    button.disabled = value;
  });
  const cancel = ensureDialog().querySelector<HTMLButtonElement>('[data-ytld-cancel]');
  const hide = ensureDialog().querySelector<HTMLButtonElement>('[data-ytld-hide]');
  const close = ensureDialog().querySelector<HTMLButtonElement>('[data-ytld-close]');
  if (cancel) cancel.textContent = value ? 'Cancel' : 'Close';
  if (hide) hide.hidden = !value;
  if (close) close.setAttribute('aria-label', value ? 'Hide download window' : 'Close');
}

async function beginDownload(plan: DownloadPlan): Promise<void> {
  if (!context || running) return;
  clearError();
  // Refresh at the last possible moment. On some YouTube variants the player
  // request omits the PO token and the authoritative token only arrives in the
  // native SABR request after the quality picker has already opened.
  let downloadContext: PlayerContext;
  try {
    downloadContext = getPlayerContext();
    const refreshedPlan = downloadContext.plans.find((candidate) => candidate.id === plan.id);
    if (!refreshedPlan) throw new Error('That format is no longer available. Reopen Download and try again.');
    plan = refreshedPlan;
    context = downloadContext;
  } catch (error) {
    setError(error);
    return;
  }
  const activeController = new AbortController();
  controller = activeController;
  scrollToProgressPending = true;
  setRunning(true);
  try {
    await downloadAndMux(downloadContext, plan, activeController.signal, (update) => {
      if (!activeController.signal.aborted) setProgress(update);
    });
    if (activeController.signal.aborted) {
      throw activeController.signal.reason || new DOMException('Canceled by user', 'AbortError');
    }
    setProgress({
      phase: 'done',
      label: usesBrowserStorageDestination()
        ? `Saved ${plan.label} ${plan.extension.toUpperCase()} to diagnostic browser storage.`
        : `Saved ${plan.label} ${plan.extension.toUpperCase()} to your chosen file.`,
      fraction: 1,
    });
    window.postMessage({
      type: DOWNLOAD_COMPLETE_MESSAGE,
      videoTitle: downloadContext.title,
    }, location.origin);
  } catch (error) {
    // googlevideo errors its streams with Error("Download aborted.") rather than
    // forwarding the AbortSignal's DOMException, so the signal is authoritative.
    if (activeController.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      const wrap = ensureDialog().querySelector<HTMLElement>('[data-ytld-progress-wrap]');
      if (wrap) wrap.hidden = true;
    } else {
      reportDownloadFailure(error, downloadContext, plan, currentPhase);
      setError(error);
      setProgress({ phase: currentPhase, label: 'Download stopped.', fraction: 0 });
    }
  } finally {
    if (controller === activeController) controller = null;
    setRunning(false);
  }
}

function renderPlans(plans: DownloadPlan[]): void {
  const list = ensureDialog().querySelector<HTMLElement>('[data-ytld-list]');
  if (!list) return;
  list.replaceChildren();
  const appendGroup = (title: string, groupPlans: DownloadPlan[]) => {
    if (!groupPlans.length) return;
    list.append(element('h3', { className: 'ytld-group-heading', text: title }));
    for (const plan of groupPlans) {
      const button = document.createElement('button');
      button.className = 'ytld-quality';
      button.type = 'button';
      button.dataset.ytldKind = plan.kind;
      button.dataset.ytldPlanId = plan.id;
      if (plan.kind === 'video') button.dataset.ytldVideoItag = String(plan.video.itag);
      button.dataset.ytldAudioItag = String(plan.audio.itag);
      button.append(
        element('strong', { text: plan.label }),
        element('span', { text: plan.detail }),
      );
      list.append(button);
    }
  };
  const audioPlans = plans.filter((plan) => plan.kind === 'audio');
  appendGroup('Audio only', audioPlans);
  appendGroup(audioPlans.length ? 'Video' : 'Video quality', plans.filter((plan) => plan.kind === 'video'));
}

export function openDialog(): void {
  const root = ensureDialog();
  returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  root.hidden = false;
  root.querySelector<HTMLElement>('#yt-local-downloader-dialog')?.focus({ preventScroll: true });
  if (running) return;
  clearError();
  currentPhase = 'preparing';
  const progress = root.querySelector<HTMLElement>('[data-ytld-progress-wrap]');
  if (progress) progress.hidden = true;
  const list = root.querySelector<HTMLElement>('[data-ytld-list]');
  if (list) list.textContent = 'Reading available qualities…';
  try {
    context = getPlayerContext();
    renderPlans(context.plans);
  } catch (error) {
    context = null;
    if (list) list.replaceChildren();
    setError(error);
  }
}

export function installUi(): void {
  document.addEventListener('yt-navigate-finish', () => {
    observePageHostChanges();
    renderYdownPage();
  });
  window.addEventListener('popstate', renderYdownPage);
  queueMicrotask(() => {
    observePageHostChanges();
    renderYdownPage();
  });
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const quality = event.target.closest<HTMLButtonElement>('[data-ytld-plan-id]');
    const close = event.target.closest<HTMLElement>('[data-ytld-close]');
    const hide = event.target.closest<HTMLElement>('[data-ytld-hide]');
    const cancel = event.target.closest<HTMLElement>('[data-ytld-cancel]');
    const nativeDownload = event.target.closest(NATIVE_DOWNLOAD_SELECTOR);
    if (!quality && !close && !hide && !cancel && !nativeDownload) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (quality) {
      const plan = context?.plans.find((candidate) => candidate.id === quality.dataset.ytldPlanId);
      if (plan) void beginDownload(plan);
    } else if (close) {
      closeOrHide();
    } else if (hide) {
      hideDialog();
    } else if (cancel) {
      closeOrCancel();
    } else if (nativeDownload) {
      openDialog();
    }
  }, true);
}

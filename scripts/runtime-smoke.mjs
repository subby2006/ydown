import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = process.env.YTLD_TEST_BROWSER
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const extension = resolve(process.cwd(), '../../outputs/youtube-local-downloader-extension');
const profile = await mkdtemp(join(tmpdir(), 'ytld-chrome-'));
const port = 9337;
const cancellationOnly = process.env.YTLD_CANCEL_ONLY === '1';
const audioOnly = process.env.YTLD_AUDIO_ONLY === '1';
const browser = spawn(chrome, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  `--disable-extensions-except=${extension}`,
  `--load-extension=${extension}`,
  '--enable-extensions',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-sync',
  '--metrics-recording-only',
  '--no-default-browser-check',
  '--no-first-run',
  '--mute-audio',
  '--window-position=-32000,-32000',
  '--window-size=1280,900',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

let chromeErrors = '';
browser.stderr.on('data', (chunk) => { chromeErrors += chunk; });

async function retry(action, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }
  throw lastError || new Error('Timed out');
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async open() {
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener('open', resolveOpen, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) listener(message.params);
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveSend, reject) => this.pending.set(id, { resolve: resolveSend, reject }));
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

async function waitFor(cdp, expression, timeoutMs = 30_000, label = expression) {
  return retry(async () => {
    const value = await evaluate(cdp, expression);
    if (!value) throw new Error(`Waiting for ${label}`);
    return value;
  }, timeoutMs);
}

async function navigate(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await waitFor(cdp, 'document.readyState === "complete"', 45_000, 'page load');
  await waitFor(cdp, 'Boolean(window.ytInitialPlayerResponse?.streamingData?.adaptiveFormats?.length)', 45_000, 'YouTube player formats');
  await evaluate(cdp, 'window.movie_player?.playVideo?.()');
  await waitFor(cdp, `performance.getEntriesByType('resource').some((entry) =>
    entry.name.includes('googlevideo.com/videoplayback') && entry.name.includes('sabr'))`, 30_000, 'live YouTube playback session');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
}

const report = {
  formatParity: null,
  progressAutoScroll: null,
  downloads: [],
  audioDownloads: [],
  failure: null,
  cancellation: null,
  sabrRequests: [],
  console: [],
};

let page;
try {
  const version = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!response.ok) throw new Error(`Chrome debugging endpoint returned ${response.status}`);
    return response.json();
  });
  const browserCdp = new Cdp(version.webSocketDebuggerUrl);
  await browserCdp.open();
  const { targetId } = await browserCdp.send('Target.createTarget', { url: 'about:blank' });
  const targets = await browserCdp.send('Target.getTargets');
  const target = targets.targetInfos.find((item) => item.targetId === targetId);
  page = new Cdp(target.webSocketDebuggerUrl || (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.id === targetId).webSocketDebuggerUrl);
  await page.open();
  await Promise.all([page.send('Page.enable'), page.send('Runtime.enable'), page.send('Network.enable')]);
  page.on('Runtime.consoleAPICalled', (event) => {
    const text = event.args.map((arg) => arg.value ?? arg.description ?? '').join(' ');
    if (text.includes('YT Local Downloader')) report.console.push({ type: event.type, text });
  });
  page.on('Network.requestWillBeSent', (event) => {
    if (event.request.method === 'POST' && event.request.url.includes('googlevideo.com/videoplayback')) {
      const url = new URL(event.request.url);
      report.sabrRequests.push({ requestId: event.requestId, requestNumber: url.searchParams.get('rn'), started: Date.now() });
    }
  });
  page.on('Network.loadingFinished', (event) => {
    const request = report.sabrRequests.find((item) => item.requestId === event.requestId);
    if (request) Object.assign(request, { finished: Date.now(), encodedDataLength: event.encodedDataLength });
  });
  page.on('Network.loadingFailed', (event) => {
    const request = report.sabrRequests.find((item) => item.requestId === event.requestId);
    if (request) Object.assign(request, { failed: event.errorText, canceled: event.canceled });
  });

  await navigate(page, audioOnly
    ? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    : 'https://www.youtube.com/watch?v=WUcYTAiCQyQ');
  await evaluate(page, `(() => {
    const trigger = document.createElement('ytd-download-button-renderer');
    trigger.id = 'ytld-smoke-trigger';
    document.body.append(trigger);
    trigger.click();
  })()`);
  await waitFor(page, 'Boolean(document.querySelector("#yt-local-downloader-dialog"))', 15_000, 'extension dialog');
  report.formatParity = await evaluate(page, `(() => {
    const formats = window.ytInitialPlayerResponse.streamingData.adaptiveFormats;
    const supportedAudioContainers = new Set(formats
      .filter((format) => !format.width && format.audioQuality)
      .map((format) => format.mimeType.includes('webm') ? 'webm' : format.mimeType.includes('mp4') ? 'mp4' : null)
      .filter(Boolean));
    const exposed = formats.filter((format) => format.width && format.height)
      .filter((format) => supportedAudioContainers.has(format.mimeType.includes('webm') ? 'webm' : format.mimeType.includes('mp4') ? 'mp4' : null));
    const buttons = [...document.querySelectorAll('[data-ytld-video-itag]')];
    const rawItags = [...new Set(exposed.map((format) => String(format.itag)))].sort();
    const uiItags = [...new Set(buttons.map((button) => button.dataset.ytldVideoItag))].sort();
    return {
      rawVideoCount: exposed.length,
      rawAudioCount: formats.filter((format) => !format.width && format.audioQuality).length,
      rawUniqueItagCount: rawItags.length,
      uiCount: buttons.length,
      rawItags,
      uiItags,
      missing: rawItags.filter((itag) => !uiItags.includes(itag)),
      extra: uiItags.filter((itag) => !rawItags.includes(itag)),
      choices: buttons.map((button) => button.innerText.trim().replace(/\\n/g, ' — ')),
      focused: document.activeElement?.id,
    };
  })()`);

  if (audioOnly) {
    report.audioChoices = await evaluate(page, `(() => [...document.querySelectorAll('[data-ytld-kind="audio"]')].map((button) => ({
      itag: button.dataset.ytldAudioItag,
      text: button.innerText.trim().replace(/\\n/g, ' — '),
    })))()`);
    await evaluate(page, `(() => { Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async (options) => {
        const extension = options.suggestedName.split('.').pop();
        const name = 'ytld-audio-smoke-' + Date.now() + '.' + extension;
        window.__ytldLastFile = name;
        return (await navigator.storage.getDirectory()).getFileHandle(name, { create: true });
      },
    }); return true; })()`);
    for (const container of ['M4A', 'WEBM']) {
      const previousFile = await evaluate(page, 'window.__ytldLastFile || null');
      const selected = await evaluate(page, `(() => {
        const choices = [...document.querySelectorAll('[data-ytld-kind="audio"]')]
          .filter((button) => button.innerText.includes('${container}'));
        choices.sort((left, right) => Number(left.querySelector('strong').innerText.replace(/\\D/g,'')) - Number(right.querySelector('strong').innerText.replace(/\\D/g,'')));
        const button = choices[0];
        if (!button) return null;
        const choice = button.innerText.trim().replace(/\\n/g, ' — ');
        button.click();
        return choice;
      })()`);
      if (!selected) throw new Error(`No ${container} audio-only choice found`);
      await waitFor(page, `window.__ytldLastFile && window.__ytldLastFile !== ${JSON.stringify(previousFile)}`, 15_000, `${container} audio destination`);
      await waitFor(page, `[...document.querySelectorAll('.ytld-quality')].some((button) => button.disabled)`, 15_000, `${container} audio transfer start`);
      await waitFor(page, `document.querySelector('[data-ytld-progress-label]')?.textContent?.startsWith('Saved ') && [...document.querySelectorAll('.ytld-quality')].every((button) => !button.disabled)`, 300_000, `${container} audio download`);
      const file = await evaluate(page, `(async () => {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle(window.__ytldLastFile);
        const file = await handle.getFile();
        const first = new Uint8Array(await file.slice(0, Math.min(file.size, 64)).arrayBuffer());
        const ascii = new TextDecoder('latin1').decode(first);
        const containerText = new TextDecoder('latin1').decode(await file.arrayBuffer());
        const objectUrl = URL.createObjectURL(file);
        const playback = await new Promise((resolve) => {
          const audio = document.createElement('audio');
          const timeout = setTimeout(() => resolve({ playable: false, mediaError: 'metadata timeout' }), 10_000);
          audio.addEventListener('loadedmetadata', () => {
            clearTimeout(timeout);
            resolve({ playable: true, durationSeconds: audio.duration });
          }, { once: true });
          audio.addEventListener('error', () => {
            clearTimeout(timeout);
            resolve({ playable: false, mediaError: audio.error?.message || 'media error' });
          }, { once: true });
          audio.preload = 'metadata';
          audio.src = objectUrl;
        });
        URL.revokeObjectURL(objectUrl);
        return {
          name: file.name,
          size: file.size,
          firstHex: [...first.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
          hasFtyp: ascii.includes('ftyp'),
          hasEbmlHeader: first[0] === 0x1a && first[1] === 0x45 && first[2] === 0xdf && first[3] === 0xa3,
          hasEmbeddedThumbnail: containerText.includes('covr')
            || containerText.includes('thumbnail.jpg'),
          ...playback,
          progress: document.querySelector('[data-ytld-progress-label]')?.textContent,
          error: document.querySelector('[data-ytld-error]')?.innerText || null,
        };
      })()`);
      report.audioDownloads.push({ container, selected, ...file });
    }
  } else {
  // Use a regular, short /watch video for real transfer checks. Some Marc
  // Brunet uploads reject isolated test profiles with sabr.malformed_config.
  await navigate(page, 'https://www.youtube.com/watch?v=HtY1314w1V4');
  await evaluate(page, `(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async (options) => {
        const extension = options.suggestedName.split('.').pop();
        const name = 'ytld-smoke-' + Date.now() + '.' + extension;
        window.__ytldLastFile = name;
        return (await navigator.storage.getDirectory()).getFileHandle(name, { create: true });
      },
    });
    const trigger = document.createElement('ytd-download-button-renderer');
    document.body.append(trigger);
    trigger.click();
  })()`);
  await waitFor(page, 'document.querySelectorAll("[data-ytld-video-itag]").length > 0', 15_000, 'download choices');

  if (!cancellationOnly) for (const container of ['MP4', 'WEBM']) {
    const previousFile = await evaluate(page, 'window.__ytldLastFile || null');
    const selected = await evaluate(page, `(() => {
      const choices = [...document.querySelectorAll('.ytld-quality')]
        .filter((button) => button.innerText.includes('${container}'));
      choices.sort((left, right) => Number(left.querySelector('strong').innerText.replace(/\\D/g,'')) - Number(right.querySelector('strong').innerText.replace(/\\D/g,'')));
      const button = choices[0];
      if (!button) return null;
      const choice = button.innerText.trim().replace(/\\n/g, ' — ');
      button.click();
      return choice;
    })()`);
    if (!selected) throw new Error(`No ${container} choice found`);
    await waitFor(page, `window.__ytldLastFile && window.__ytldLastFile !== ${JSON.stringify(previousFile)}`, 15_000, `${container} destination creation`);
    await waitFor(page, `[...document.querySelectorAll('.ytld-quality')].some((button) => button.disabled)`, 15_000, `${container} transfer start`);
    if (!report.progressAutoScroll) {
      report.progressAutoScroll = await waitFor(page, `(() => {
        const panel = document.querySelector('#yt-local-downloader-dialog');
        const progress = document.querySelector('[data-ytld-progress-wrap]');
        if (!panel || !progress || progress.hidden) return null;
        const remaining = panel.scrollHeight - panel.scrollTop - panel.clientHeight;
        if (remaining > 4) return null;
        const rect = progress.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        return {
          nearBottom: true,
          remaining,
          progressVisible: rect.bottom <= panelRect.bottom && rect.top >= panelRect.top,
        };
      })()`, 15_000, 'automatic progress scroll');
    }
    await waitFor(page, `document.querySelector('[data-ytld-progress-label]')?.textContent?.startsWith('Saved ') && [...document.querySelectorAll('.ytld-quality')].every((button) => !button.disabled)`, 300_000, `${container} download and mux`);
    const file = await evaluate(page, `(async () => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(window.__ytldLastFile);
      const file = await handle.getFile();
      const first = new Uint8Array(await file.slice(0, Math.min(file.size, 64)).arrayBuffer());
      const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 1048576)).arrayBuffer());
      const scan = new Uint8Array(await file.arrayBuffer());
      const ascii = (bytes) => new TextDecoder('latin1').decode(bytes);
      const containerText = ascii(scan);
      return {
        name: file.name,
        size: file.size,
        firstHex: [...first.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
        hasFtyp: ascii(first).includes('ftyp'),
        hasMoovNearEnd: ascii(tail).includes('moov'),
        hasEbmlHeader: first[0] === 0x1a && first[1] === 0x45 && first[2] === 0xdf && first[3] === 0xa3,
        hasEmbeddedThumbnail: containerText.includes('covr')
          || (containerText.includes('thumbnail.jpg') && containerText.includes('image/jpeg')),
        progress: document.querySelector('[data-ytld-progress-label]')?.textContent,
        error: document.querySelector('[data-ytld-error]')?.innerText || null,
      };
    })()`);
    report.downloads.push({ container, selected, ...file });
  }

  if (!cancellationOnly) {
    await waitFor(page, `[...document.querySelectorAll('.ytld-quality')].every((button) => !button.disabled)`, 10_000, 'idle download controls');
    await evaluate(page, `(() => {
    window.__ytldPickerWaiting = false;
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async (options) => {
        window.__ytldPickerWaiting = true;
        await new Promise((resolve) => { window.__ytldReleasePicker = resolve; });
        const extension = options.suggestedName.split('.').pop();
        return (await navigator.storage.getDirectory()).getFileHandle('ytld-failure.' + extension, { create: true });
      },
    });
    document.querySelector('.ytld-quality').click();
  })()`);
    await waitFor(page, 'window.__ytldPickerWaiting === true', 10_000, 'save picker barrier');
    await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await evaluate(page, 'window.__ytldReleasePicker()');
    report.failure = await waitFor(page, `(() => {
    const node = document.querySelector('[data-ytld-error]');
    if (!node || node.hidden) return null;
    return {
      text: node.innerText,
      role: node.getAttribute('role'),
      ariaLive: node.getAttribute('aria-live'),
      focused: document.activeElement === node,
      progress: document.querySelector('[data-ytld-progress-label]')?.textContent,
      controlsEnabled: [...document.querySelectorAll('.ytld-quality')].every((button) => !button.disabled),
      errorAfterProgress: Boolean(document.querySelector('[data-ytld-progress-wrap]')
        ?.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING),
    };
  })()`, 120_000, 'surfaced network failure');
    await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  }

  await evaluate(page, `(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async (options) => {
        const extension = options.suggestedName.split('.').pop();
        return (await navigator.storage.getDirectory()).getFileHandle('ytld-cancel.' + extension, { create: true });
      },
    });
    const choices = [...document.querySelectorAll('.ytld-quality')];
    choices.sort((left, right) => Number(right.querySelector('strong').innerText.replace(/\\D/g,'')) - Number(left.querySelector('strong').innerText.replace(/\\D/g,'')));
    choices[0].click();
  })()`);
  await waitFor(page, `document.querySelector('[data-ytld-progress-label]')?.textContent?.includes('request')`, 30_000, 'active transfer');
  await evaluate(page, `document.querySelector('[data-ytld-cancel]').click()`);
  report.cancellation = await waitFor(page, `(() => {
    const cancel = document.querySelector('[data-ytld-cancel]');
    if (cancel?.textContent !== 'Close') return null;
    return {
      errorVisible: !document.querySelector('[data-ytld-error]').hidden,
      progressHidden: document.querySelector('[data-ytld-progress-wrap]').hidden,
      controlsEnabled: [...document.querySelectorAll('.ytld-quality')].every((button) => !button.disabled),
    };
  })()`, 30_000, 'clean cancellation');
  }

  console.log(JSON.stringify(report, null, 2));
  page.close();
  browserCdp.close();
} catch (error) {
  console.error(error.stack || error);
  console.error(`Partial report:\n${JSON.stringify(report, null, 2)}`);
  if (chromeErrors) console.error(chromeErrors.slice(-4000));
  process.exitCode = 1;
} finally {
  if (page) page.close();
  browser.kill();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}

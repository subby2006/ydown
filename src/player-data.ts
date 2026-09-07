import { buildSabrFormat } from 'googlevideo/utils';
import type { SabrFormat } from 'googlevideo/shared-types';
import type { CapturedSession, DownloadPlan, JsonObject, PlayerContext } from './types';

export const captured: CapturedSession = {
  playerResponse: null,
  playerVideoId: null,
  poTokenByVideoId: new Map(),
  sabrUrlByVideoId: new Map(),
};

const nativeFetch = window.fetch.bind(window);

function currentVideoId(): string | null {
  const url = new URL(location.href);
  return url.searchParams.get('v') || (url.pathname.startsWith('/shorts/') ? url.pathname.split('/')[2] : null);
}

function looksLikeSabrUrl(value: string): boolean {
  try {
    const url = new URL(value, location.href);
    return url.hostname.endsWith('.googlevideo.com')
      && url.pathname.includes('/videoplayback')
      && (url.searchParams.has('sabr') || url.search.includes('sabr'));
  } catch {
    return false;
  }
}

function recordSabrUrl(value: string): void {
  if (!looksLikeSabrUrl(value)) return;
  const videoId = currentVideoId();
  if (videoId) captured.sabrUrlByVideoId.set(videoId, value);
}

function recordPlayerResponse(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const response = value as JsonObject;
  const videoId = response.videoDetails?.videoId;
  if (typeof videoId !== 'string') return;
  captured.playerResponse = response;
  captured.playerVideoId = videoId;
}

function inspectPlayerRequestBody(body: unknown): void {
  if (typeof body !== 'string') return;
  try {
    const data = JSON.parse(body) as JsonObject;
    const videoId = data.videoId;
    const poToken = data.serviceIntegrityDimensions?.poToken;
    if (typeof videoId === 'string' && typeof poToken === 'string' && poToken) {
      captured.poTokenByVideoId.set(videoId, poToken);
    }
  } catch {
    // Non-JSON request body.
  }
}

function inspectPlayerResponse(response: Response): void {
  void response.clone().json().then(recordPlayerResponse).catch(() => undefined);
}

export function installNetworkCapture(): void {
  const originalFetch = window.fetch;
  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    recordSabrUrl(url);

    if (url.includes('/youtubei/v1/player')) {
      inspectPlayerRequestBody(init?.body);
      if (input instanceof Request) {
        void input.clone().text().then(inspectPlayerRequestBody).catch(() => undefined);
      }
    }

    const result = Reflect.apply(originalFetch, this, [input, init]) as Promise<Response>;
    if (url.includes('/youtubei/v1/player')) {
      void result.then(inspectPlayerResponse).catch(() => undefined);
    }
    return result;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const requestUrl = Symbol('yt-local-downloader-url');

  const patchedOpen = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async: boolean = true,
    username?: string | null,
    password?: string | null,
  ): void {
    const value = String(url);
    (this as XMLHttpRequest & { [requestUrl]?: string })[requestUrl] = value;
    recordSabrUrl(value);
    return originalOpen.call(this, method, url, async, username, password);
  };
  XMLHttpRequest.prototype.open = patchedOpen as typeof XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.send = function patchedSend(body?: Document | XMLHttpRequestBodyInit | null): void {
    const url = (this as XMLHttpRequest & { [requestUrl]?: string })[requestUrl] || '';
    if (url.includes('/youtubei/v1/player')) {
      inspectPlayerRequestBody(body);
      this.addEventListener('load', () => {
        try {
          if (typeof this.response === 'object' && this.response) recordPlayerResponse(this.response);
          else if (typeof this.responseText === 'string') recordPlayerResponse(JSON.parse(this.responseText));
        } catch {
          // Ignore opaque or non-JSON responses.
        }
      }, { once: true });
    }
    return originalSend.call(this, body);
  };

  try {
    for (const entry of performance.getEntriesByType('resource')) recordSabrUrl(entry.name);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) recordSabrUrl(entry.name);
    }).observe({ type: 'resource', buffered: true });
  } catch {
    // Resource Timing may be unavailable in a hardened browser.
  }
}

function parseAssignedJson(source: string, marker: string): JsonObject | null {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = source.indexOf('{', markerIndex + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) {
      try {
        return JSON.parse(source.slice(start, index + 1)) as JsonObject;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function responseFromPage(): JsonObject | null {
  const videoId = currentVideoId();
  const candidates = [
    captured.playerVideoId === videoId ? captured.playerResponse : null,
    window.movie_player?.getPlayerResponse?.(),
    window.ytInitialPlayerResponse,
  ];
  for (const candidate of candidates) {
    if (candidate?.videoDetails?.videoId === videoId) return candidate;
  }

  for (const script of document.scripts) {
    const text = script.textContent || '';
    if (!text.includes('ytInitialPlayerResponse')) continue;
    const parsed = parseAssignedJson(text, 'ytInitialPlayerResponse');
    if (parsed?.videoDetails?.videoId === videoId) return parsed;
  }
  return null;
}

function normalizedFormat(raw: JsonObject): SabrFormat | null {
  try {
    const format = buildSabrFormat({
      ...raw,
      audioTrackId: raw.audioTrackId ?? raw.audioTrack?.id,
      language: raw.language ?? raw.audioTrack?.id?.split('.')[0] ?? null,
      is_original: raw.isOriginal ?? raw.audioTrack?.audioIsDefault ?? false,
      is_drc: raw.isDrc ?? /drc/i.test(raw.audioTrack?.displayName || ''),
    } as any);
    // googlevideo intentionally keeps only fields needed by SABR. Preserve the
    // display metadata YouTube exposes so distinct encodes remain distinguishable.
    Object.assign(format, {
      fps: Number(raw.fps) || undefined,
      qualityLabel: raw.qualityLabel || raw.quality_label || format.qualityLabel,
    });
    return format;
  } catch {
    return null;
  }
}

function fpsOf(format: SabrFormat): number {
  return Number((format as SabrFormat & { fps?: number }).fps) || 0;
}

function containerOf(format: SabrFormat): 'mp4' | 'webm' | null {
  const mime = format.mimeType || '';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4')) return 'mp4';
  return null;
}

function codecLabel(mimeType = ''): string {
  const codec = /codecs="([^"]+)/.exec(mimeType)?.[1]?.split(',')[0] || '';
  if (codec.startsWith('avc1')) return 'H.264';
  if (codec.startsWith('vp09') || codec.startsWith('vp9')) return 'VP9';
  if (codec.startsWith('av01')) return 'AV1';
  return codec || 'video';
}

function audioCodecLabel(mimeType = ''): string {
  const codec = /codecs="([^"]+)/.exec(mimeType)?.[1]?.split(',')[0] || '';
  if (codec.startsWith('mp4a')) return 'AAC';
  if (codec.includes('opus')) return 'Opus';
  return codec || 'audio';
}

function audioScore(format: SabrFormat): number {
  return (format.isOriginal ? 1_000_000 : 0)
    + (!format.isDubbed && !format.isAutoDubbed ? 100_000 : 0)
    + (!format.isDrc ? 10_000 : 0)
    + format.bitrate;
}

interface H264ifyPreferences {
  extensionName: 'h264ify' | 'enhanced-h264ify';
  blockedVideoTokens: string[];
  blockedAudioTokens: string[];
  blockHighFrameRate: boolean;
}

function functionSource(value: unknown): string {
  try {
    return typeof value === 'function' ? Function.prototype.toString.call(value) : '';
  } catch {
    return '';
  }
}

function storedTrue(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

/**
 * Both extensions install a MIME-type checker in YouTube's main world and
 * mirror their settings into the page's localStorage. Looking for the active
 * wrapper as well as its keys prevents stale settings left behind after an
 * uninstall from changing the download menu.
 */
function h264ifyPreferences(): H264ifyPreferences | null {
  const checkerSource = [
    functionSource(window.MediaSource?.isTypeSupported),
    functionSource(window.HTMLMediaElement?.prototype?.canPlayType),
  ].join('\n');

  if (checkerSource.includes('enhanced-h264ify-block_')) {
    const blockedVideoTokens: string[] = [];
    const blockedAudioTokens: string[] = [];
    if (storedTrue('enhanced-h264ify-block_h264')) blockedVideoTokens.push('avc');
    if (storedTrue('enhanced-h264ify-block_vp8')) blockedVideoTokens.push('vp8');
    if (storedTrue('enhanced-h264ify-block_vp9')) blockedVideoTokens.push('vp9', 'vp09');
    if (storedTrue('enhanced-h264ify-block_av1')) blockedVideoTokens.push('av01', 'av99');
    if (storedTrue('enhanced-h264ify-block_opus')) blockedAudioTokens.push('opus');
    if (storedTrue('enhanced-h264ify-block_mp4a')) blockedAudioTokens.push('mp4a');
    return {
      extensionName: 'enhanced-h264ify',
      blockedVideoTokens,
      blockedAudioTokens,
      blockHighFrameRate: storedTrue('enhanced-h264ify-block_60fps'),
    };
  }

  if (checkerSource.includes('h264ify-block_60fps')) {
    // Original h264ify rejects every WebM stream as well as the codec tokens
    // below whenever its main-world wrapper is active.
    return {
      extensionName: 'h264ify',
      blockedVideoTokens: ['webm', 'vp8', 'vp9', 'av01'],
      blockedAudioTokens: [],
      blockHighFrameRate: storedTrue('h264ify-block_60fps'),
    };
  }

  return null;
}

function isBlockedVideo(format: SabrFormat, preferences: H264ifyPreferences | null): boolean {
  if (!preferences) return false;
  const mimeType = (format.mimeType || '').toLowerCase();
  return preferences.blockedVideoTokens.some((token) => mimeType.includes(token))
    || (preferences.blockHighFrameRate && fpsOf(format) > 30);
}

function isBlockedAudio(format: SabrFormat, preferences: H264ifyPreferences | null): boolean {
  if (!preferences) return false;
  const mimeType = (format.mimeType || '').toLowerCase();
  return preferences.blockedAudioTokens.some((token) => mimeType.includes(token));
}

export function makePlans(
  rawFormats: JsonObject[],
  includeAudioOnly = false,
  preferences: H264ifyPreferences | null = null,
): DownloadPlan[] {
  const formats = rawFormats.map(normalizedFormat).filter((value): value is SabrFormat => Boolean(value));
  const allVideos = formats
    .filter((format) => format.width && format.height && containerOf(format))
    .sort((left, right) => right.bitrate - left.bitrate);
  const videos = allVideos.filter((format) => !isBlockedVideo(format, preferences));
  const allAudio = formats.filter((format) => !format.width && format.audioQuality && containerOf(format));
  // An audio codec disabled in enhanced-h264ify also removes video choices
  // that would require that codec. Music audio-only choices deliberately use
  // allAudio below, since they are downloads rather than browser playback.
  const videoAudio = allAudio.filter((format) => !isBlockedAudio(format, preferences));
  const videoPlans: DownloadPlan[] = [];
  const seen = new Set<string>();

  for (const video of videos) {
    const extension = containerOf(video);
    if (!extension) continue;
    const matchingAudio = videoAudio
      .filter((candidate) => containerOf(candidate) === extension)
      .sort((left, right) => audioScore(right) - audioScore(left))[0];
    if (!matchingAudio) continue;

    // An itag identifies a particular YouTube encode. Do not collapse tracks by
    // resolution/codec: YouTube often exposes both 30 fps and 60 fps versions.
    const key = `${video.itag}:${video.xtags || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const estimatedBytes = (video.contentLength || 0) + (matchingAudio.contentLength || 0);
    const fps = fpsOf(video);
    const fpsDetail = fps ? ` · ${fps} fps` : '';
    videoPlans.push({
      kind: 'video',
      id: `${video.itag}-${matchingAudio.itag}-${matchingAudio.audioTrackId || 'default'}`,
      label: video.qualityLabel || `${video.height}p`,
      detail: `${extension.toUpperCase()} · ${codecLabel(video.mimeType)}${fpsDetail}${estimatedBytes ? ` · ${formatBytes(estimatedBytes)}` : ''}`,
      extension,
      mimeType: extension === 'mp4' ? 'video/mp4' : 'video/webm',
      video,
      audio: matchingAudio,
      estimatedBytes,
    });
  }

  videoPlans.sort((left, right) => {
    const heightDifference = (right.video.height || 0) - (left.video.height || 0);
    if (heightDifference) return heightDifference;
    const fpsDifference = fpsOf(right.video) - fpsOf(left.video);
    if (fpsDifference) return fpsDifference;
    if (left.extension !== right.extension) return left.extension === 'mp4' ? -1 : 1;
    return right.video.bitrate - left.video.bitrate;
  });

  if (!includeAudioOnly || !allAudio.length || !allVideos.length) return videoPlans;

  // Keep audio-only choices on the same default/original language track used
  // for video downloads. Prefer ordinary audio over DRC/stable-volume variants.
  const bestAudio = [...allAudio].sort((left, right) => audioScore(right) - audioScore(left))[0];
  let audioCandidates = bestAudio.audioTrackId
    ? allAudio.filter((format) => format.audioTrackId === bestAudio.audioTrackId)
    : allAudio.filter((format) => !format.isDubbed && !format.isAutoDubbed);
  if (audioCandidates.some((format) => !format.isDrc)) {
    audioCandidates = audioCandidates.filter((format) => !format.isDrc);
  }

  const audioPlans: DownloadPlan[] = [];
  const seenAudio = new Set<string>();
  for (const audioFormat of audioCandidates.sort((left, right) => right.bitrate - left.bitrate)) {
    const container = containerOf(audioFormat);
    if (!container) continue;
    const companionVideo = allVideos.find((format) => containerOf(format) === container);
    if (!companionVideo) continue;
    const key = `${audioFormat.itag}:${audioFormat.xtags || ''}:${audioFormat.audioTrackId || 'default'}`;
    if (seenAudio.has(key)) continue;
    seenAudio.add(key);
    const extension = container === 'mp4' ? 'm4a' : 'webm';
    const bitrateKbps = Math.max(1, Math.round(audioFormat.bitrate / 1000));
    audioPlans.push({
      kind: 'audio',
      id: `audio-${key}`,
      label: `${bitrateKbps} kbps`,
      detail: `${extension.toUpperCase()} · ${audioCodecLabel(audioFormat.mimeType)}${audioFormat.contentLength ? ` · ${formatBytes(audioFormat.contentLength)}` : ''}`,
      extension,
      mimeType: container === 'mp4' ? 'audio/mp4' : 'audio/webm',
      // SabrStream requires both selections even in AUDIO_ONLY mode; the video
      // format is explicitly discarded by the protocol.
      video: companionVideo,
      audio: audioFormat,
      estimatedBytes: audioFormat.contentLength || 0,
    });
  }

  return [...audioPlans, ...videoPlans];
}

export function isMusicResponse(response: JsonObject): boolean {
  const musicVideoType = String(
    response.videoDetails?.musicVideoType
      || response.microformat?.playerMicroformatRenderer?.musicVideoType
      || '',
  );
  const category = String(response.microformat?.playerMicroformatRenderer?.category || '');
  const author = String(response.videoDetails?.author || '');
  return (/music_video_type/i.test(musicVideoType) && !/unknown/i.test(musicVideoType))
    || /^music$/i.test(category)
    || /\s-\sTopic$/i.test(author);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unknown size';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function ytcfgValue(key: string, fallback: unknown): unknown {
  try {
    return window.ytcfg?.get?.(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function safeInt32(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.trunc(number)));
}

function thumbnailUrls(response: JsonObject, videoId: string): string[] {
  const candidates = [
    ...(response.videoDetails?.thumbnail?.thumbnails || []),
    ...(response.microformat?.playerMicroformatRenderer?.thumbnail?.thumbnails || []),
  ]
    .filter((thumbnail: JsonObject) => typeof thumbnail?.url === 'string')
    .sort((left: JsonObject, right: JsonObject) => (
      (Number(right.width) || 0) * (Number(right.height) || 0)
      - (Number(left.width) || 0) * (Number(left.height) || 0)
    ))
    .map((thumbnail: JsonObject) => String(thumbnail.url))
    // MediaBunny's MP4 cover-art writer supports JPEG, PNG, and BMP. Avoid
    // downloading YouTube's higher-resolution WebP candidate only to reject it.
    .filter((url: string) => !/\.webp(?:[?#]|$)|\/vi_webp\//i.test(url));

  candidates.push(
    `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  );
  return [...new Set(candidates)];
}

export function getPlayerContext(): PlayerContext {
  const videoId = currentVideoId();
  if (!videoId) throw new Error('Open a YouTube video first.');
  const response = responseFromPage();
  if (!response) throw new Error('YouTube player data is not ready yet. Wait a moment and try again.');
  const playability = response.playabilityStatus?.status;
  if (playability && playability !== 'OK') {
    throw new Error(response.playabilityStatus?.reason || `This video is not playable (${playability}).`);
  }

  const streamingData = response.streamingData || {};
  const isMusic = isMusicResponse(response);
  const playbackPreferences = h264ifyPreferences();
  const plans = makePlans(streamingData.adaptiveFormats || [], isMusic, playbackPreferences);
  if (playbackPreferences) {
    console.info(`[YT Local Downloader] Respecting ${playbackPreferences.extensionName} format preferences.`, {
      blockedVideoTokens: playbackPreferences.blockedVideoTokens,
      blockedAudioTokens: playbackPreferences.blockedAudioTokens,
      blockHighFrameRate: playbackPreferences.blockHighFrameRate,
    });
  }
  if (!plans.length) throw new Error('No compatible adaptive video and audio formats were found.');

  // Prefer a URL that YouTube's own player successfully requested. The URL in
  // streamingData is a fallback because it is not always fetchable from the page
  // context even when it looks complete.
  const serverAbrStreamingUrl = captured.sabrUrlByVideoId.get(videoId) || streamingData.serverAbrStreamingUrl;
  if (!serverAbrStreamingUrl) {
    throw new Error('The SABR stream URL is not ready. Start playback briefly, then try Download again.');
  }

  const videoPlaybackUstreamerConfig = response.playerConfig?.mediaCommonConfig
    ?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig;
  if (!videoPlaybackUstreamerConfig) throw new Error('YouTube did not provide the SABR session configuration.');

  const durationMs = Number(response.videoDetails?.lengthSeconds || 0) * 1000
    || plans[0].video.approxDurationMs;
  const language = navigator.language || 'en-US';
  const [acceptLanguage, acceptRegion = 'US'] = language.split('-');

  return {
    videoId,
    title: response.videoDetails?.title || document.title.replace(/\s*-\s*YouTube\s*$/, ''),
    thumbnailUrls: thumbnailUrls(response, videoId),
    response,
    serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig,
    poToken: captured.poTokenByVideoId.get(videoId),
    clientInfo: {
      clientName: safeInt32(ytcfgValue('INNERTUBE_CONTEXT_CLIENT_NAME', 1), 1),
      clientVersion: String(ytcfgValue('INNERTUBE_CONTEXT_CLIENT_VERSION', '2.20250101.00.00')),
      osName: navigator.platform || 'Windows',
      osVersion: '',
      acceptLanguage,
      acceptRegion,
      screenWidthPoints: safeInt32(screen.width, 0),
      screenHeightPoints: safeInt32(screen.height, 0),
      windowWidthPoints: safeInt32(innerWidth, 0),
      windowHeightPoints: safeInt32(innerHeight, 0),
      // `screenPixelDensity` is int32 (DPI-like); DPR belongs in this float field.
      screenDensityFloat: Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1,
      utcOffsetMinutes: String(-new Date().getTimezoneOffset()),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    durationMs,
    isMusic,
    plans,
  };
}

export function browserFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return nativeFetch(input, init);
}

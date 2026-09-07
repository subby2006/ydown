import { SabrStream } from 'googlevideo/sabr-stream';
import { VideoPlaybackAbrRequest } from 'googlevideo/protos';
import { EnabledTrackTypes } from 'googlevideo/utils';
import {
  BlobSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  MP4,
  StreamTarget,
  WEBM,
  WebMOutputFormat,
  type AttachedImage,
  type StreamTargetChunk,
} from 'mediabunny';
import { browserFetch, formatBytes } from './player-data';
import type { DownloadPlan, PlayerContext, ProgressUpdate } from './types';

interface TemporaryTracks {
  root: FileSystemDirectoryHandle;
  videoName: string;
  audioName: string;
  videoFile: File;
  audioFile: File;
}

interface SabrResponseSummary {
  requestId: number;
  status: number;
  statusText: string;
  contentType: string;
  elapsedMs: number;
  protectionStatus: number;
  sabrErrorType?: string;
  sabrErrorCode?: string;
}

type ErrorWithSabrResponse = Error & { sabrResponse?: SabrResponseSummary };

const SABR_PLAYBACK_RATE = 2;
let sabrPlaybackRateLogged = false;

function withSabrPlaybackRate(init?: RequestInit): RequestInit | undefined {
  if (!(init?.body instanceof Uint8Array)) return init;

  try {
    const request = VideoPlaybackAbrRequest.decode(init.body);
    if (!request.clientAbrState) return init;
    request.clientAbrState.playbackRate = SABR_PLAYBACK_RATE;
    if (!sabrPlaybackRateLogged) {
      console.debug(`[YT Local Downloader] SABR pacing: reporting ${SABR_PLAYBACK_RATE}x playback`);
      sabrPlaybackRateLogged = true;
    }
    return {
      ...init,
      body: VideoPlaybackAbrRequest.encode(request).finish() as unknown as BodyInit,
    };
  } catch (error) {
    console.warn('[YT Local Downloader] Could not apply SABR playback-rate boost; using the original request.', error);
    return init;
  }
}

function attachSabrResponse(
  error: unknown,
  response: Omit<SabrResponseSummary, 'protectionStatus'> | null,
  protectionStatus: number,
): unknown {
  if (!response) return error;
  const target: ErrorWithSabrResponse = error instanceof Error ? error : new Error(String(error));
  const summary: SabrResponseSummary = { ...response, protectionStatus };
  const sabrError = /SABR Error:\s*(.+?)\s*-\s*(.+)$/i.exec(target.message);
  if (sabrError) {
    summary.sabrErrorType = sabrError[1].trim().slice(0, 120);
    summary.sabrErrorCode = sabrError[2].trim().slice(0, 120);
  }
  target.sabrResponse = summary;
  return target;
}

export function safeFilename(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  const result = reserved.test(cleaned) ? `_${cleaned}` : cleaned;
  return (result || 'YouTube video').slice(0, 180);
}

async function chooseDestination(context: PlayerContext, plan: DownloadPlan): Promise<FileSystemFileHandle> {
  if (!window.showSaveFilePicker) {
    throw new Error('This browser does not support direct file saving. Use current Chrome or Edge.');
  }
  return window.showSaveFilePicker({
    suggestedName: `${safeFilename(context.title)}.${plan.extension}`,
    types: [{
      description: plan.kind === 'audio'
        ? plan.extension === 'm4a' ? 'MPEG-4 audio' : 'WebM audio'
        : plan.extension === 'mp4' ? 'MPEG-4 video' : 'WebM video',
      accept: { [plan.mimeType]: [`.${plan.extension}`] },
    }],
  });
}

async function downloadAudioOnly(
  context: PlayerContext,
  plan: DownloadPlan,
  destination: FileSystemFileHandle,
  signal: AbortSignal,
  onProgress: (update: ProgressUpdate) => void,
): Promise<void> {
  let requestCount = 0;
  let lastSabrResponse: Omit<SabrResponseSummary, 'protectionStatus'> | null = null;
  const tracedFetch: typeof fetch = async (input, init) => {
    requestCount += 1;
    const requestId = requestCount;
    const startedAt = performance.now();
    onProgress({ phase: 'downloading', label: `Requesting YouTube audio… request ${requestId}`, fraction: null });
    try {
      const response = await browserFetch(input, withSabrPlaybackRate(init));
      const elapsedMs = Math.round(performance.now() - startedAt);
      lastSabrResponse = {
        requestId,
        status: response.status,
        statusText: response.statusText.slice(0, 120),
        contentType: (response.headers.get('content-type') || '').slice(0, 160),
        elapsedMs,
      };
      console.debug(
        `[YT Local Downloader] Audio SABR request ${requestId}: HTTP ${response.status} (${elapsedMs} ms to headers)`,
      );
      return response;
    } catch (error) {
      console.error(`[YT Local Downloader] Audio SABR request ${requestId} failed`, error);
      throw error;
    }
  };

  const sabr = new SabrStream({
    fetch: tracedFetch,
    serverAbrStreamingUrl: context.serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig: context.videoPlaybackUstreamerConfig,
    clientInfo: context.clientInfo,
    poToken: context.poToken,
    durationMs: context.durationMs,
    formats: context.plans.flatMap((item) => [item.video, item.audio]),
  });
  const abort = () => sabr.abort();
  signal.addEventListener('abort', abort, { once: true });
  let protectionStatus = 0;
  sabr.on('streamProtectionStatusUpdate', (status) => {
    protectionStatus = status.status || 0;
  });

  try {
    onProgress({ phase: 'preparing', label: 'Starting YouTube audio stream…', fraction: 0.02 });
    const result = await sabr.start({
      videoFormat: plan.video,
      audioFormat: plan.audio,
      enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
      preferMP4: plan.mimeType === 'audio/mp4',
      preferWebM: plan.mimeType === 'audio/webm',
      maxRetries: 6,
      stallDetectionMs: 30_000,
    });
    const expectedBytes = Math.max(1, plan.estimatedBytes);
    let receivedBytes = 0;
    await writeStream(result.audioStream, destination, (count) => {
      receivedBytes += count;
      const fraction = plan.estimatedBytes ? Math.min(0.99, receivedBytes / expectedBytes) : null;
      onProgress({
        phase: 'downloading',
        label: plan.estimatedBytes
          ? `Downloading audio… ${formatBytes(receivedBytes)} of ${formatBytes(expectedBytes)} · ${Math.min(100, Math.round((receivedBytes / expectedBytes) * 100))}% · ${requestCount} request${requestCount === 1 ? '' : 's'}`
          : `Downloading audio… ${formatBytes(receivedBytes)} · ${requestCount} request${requestCount === 1 ? '' : 's'}`,
        fraction,
      });
    });
    if (protectionStatus === 3) {
      throw new Error('YouTube requires a fresh playback token. Reload the video, play it briefly, and retry.');
    }
  } catch (error) {
    throw attachSabrResponse(error, lastSabrResponse, protectionStatus);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function writeStream(
  stream: ReadableStream<Uint8Array>,
  handle: FileSystemFileHandle,
  onBytes: (byteLength: number) => void,
): Promise<File> {
  const writable = await handle.createWritable();
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(new Uint8Array(value));
      onBytes(value.byteLength);
    }
    await writable.close();
    return handle.getFile();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function downloadTemporaryTracks(
  context: PlayerContext,
  plan: DownloadPlan,
  signal: AbortSignal,
  onProgress: (update: ProgressUpdate) => void,
): Promise<TemporaryTracks> {
  if (!navigator.storage.getDirectory) {
    throw new Error('Origin-private browser storage is unavailable.');
  }
  const root = await navigator.storage.getDirectory();
  const nonce = `${context.videoId}-${Date.now()}-${crypto.randomUUID()}`;
  const videoName = `yt-local-${nonce}-video.part`;
  const audioName = `yt-local-${nonce}-audio.part`;
  const [videoHandle, audioHandle] = await Promise.all([
    root.getFileHandle(videoName, { create: true }),
    root.getFileHandle(audioName, { create: true }),
  ]);

  let requestCount = 0;
  let lastSabrResponse: Omit<SabrResponseSummary, 'protectionStatus'> | null = null;
  const tracedFetch: typeof fetch = async (input, init) => {
    requestCount += 1;
    const requestId = requestCount;
    const startedAt = performance.now();
    onProgress({
      phase: 'downloading',
      label: `Requesting YouTube media… request ${requestId}`,
      fraction: null,
    });
    try {
      const response = await browserFetch(input, withSabrPlaybackRate(init));
      const elapsedMs = Math.round(performance.now() - startedAt);
      lastSabrResponse = {
        requestId,
        status: response.status,
        statusText: response.statusText.slice(0, 120),
        contentType: (response.headers.get('content-type') || '').slice(0, 160),
        elapsedMs,
      };
      console.debug(
        `[YT Local Downloader] SABR request ${requestId}: HTTP ${response.status} (${elapsedMs} ms to headers)`,
      );
      return response;
    } catch (error) {
      console.error(`[YT Local Downloader] SABR request ${requestId} failed`, error);
      throw error;
    }
  };

  const sabr = new SabrStream({
    fetch: tracedFetch,
    serverAbrStreamingUrl: context.serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig: context.videoPlaybackUstreamerConfig,
    clientInfo: context.clientInfo,
    poToken: context.poToken,
    durationMs: context.durationMs,
    formats: context.plans.flatMap((item) => [item.video, item.audio]),
  });
  const abort = () => sabr.abort();
  signal.addEventListener('abort', abort, { once: true });

  let protectionStatus = 0;
  sabr.on('streamProtectionStatusUpdate', (status) => {
    protectionStatus = status.status || 0;
  });

  try {
    onProgress({ phase: 'preparing', label: 'Starting YouTube stream…', fraction: 0.02 });
    const result = await sabr.start({
      videoFormat: plan.video,
      audioFormat: plan.audio,
      enabledTrackTypes: EnabledTrackTypes.VIDEO_AND_AUDIO,
      preferMP4: plan.extension === 'mp4',
      preferWebM: plan.extension === 'webm',
      maxRetries: 6,
      stallDetectionMs: 30_000,
    });

    const expectedBytes = Math.max(1, plan.estimatedBytes);
    let receivedBytes = 0;
    const reportBytes = (count: number) => {
      receivedBytes += count;
      const fraction = plan.estimatedBytes
        ? Math.min(0.78, 0.05 + (receivedBytes / expectedBytes) * 0.73)
        : null;
      onProgress({
        phase: 'downloading',
        label: plan.estimatedBytes
          ? `Downloading tracks… ${formatBytes(receivedBytes)} of ${formatBytes(expectedBytes)} · ${Math.min(100, Math.round((receivedBytes / expectedBytes) * 100))}% · ${requestCount} request${requestCount === 1 ? '' : 's'}`
          : `Downloading video and audio tracks… ${formatBytes(receivedBytes)} · ${requestCount} request${requestCount === 1 ? '' : 's'}`,
        fraction,
      });
    };

    const [videoFile, audioFile] = await Promise.all([
      writeStream(result.videoStream, videoHandle, reportBytes),
      writeStream(result.audioStream, audioHandle, reportBytes),
    ]);
    if (protectionStatus === 3) {
      throw new Error('YouTube requires a fresh playback token. Reload the video with the userscript enabled, play it briefly, and retry.');
    }
    return { root, videoName, audioName, videoFile, audioFile };
  } catch (error) {
    await Promise.allSettled([
      root.removeEntry(videoName),
      root.removeEntry(audioName),
    ]);
    throw attachSabrResponse(error, lastSabrResponse, protectionStatus);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function fetchVideoThumbnail(
  context: PlayerContext,
  signal: AbortSignal,
  onProgress: (update: ProgressUpdate) => void,
): Promise<AttachedImage | null> {
  const supportedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/bmp']);
  onProgress({ phase: 'muxing', label: 'Fetching video thumbnail…', fraction: 0.79 });

  for (const url of context.thumbnailUrls) {
    try {
      const response = await browserFetch(url, { signal, credentials: 'omit' });
      if (!response.ok) continue;
      const mimeType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
      if (!supportedMimeTypes.has(mimeType)) continue;
      const data = new Uint8Array(await response.arrayBuffer());
      if (!data.byteLength) continue;
      return {
        data,
        mimeType,
        kind: 'coverFront',
        name: `thumbnail.${mimeType === 'image/png' ? 'png' : mimeType === 'image/bmp' ? 'bmp' : 'jpg'}`,
        description: 'YouTube video thumbnail',
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason || error;
      console.warn('[YT Local Downloader] Could not fetch a video thumbnail candidate', error);
    }
  }

  console.warn('[YT Local Downloader] No compatible video thumbnail was available; saving without artwork.');
  return null;
}

async function muxTracks(
  tracks: TemporaryTracks,
  destination: FileSystemFileHandle,
  context: PlayerContext,
  plan: DownloadPlan,
  thumbnail: AttachedImage | null,
  signal: AbortSignal,
  onProgress: (update: ProgressUpdate) => void,
): Promise<void> {
  const inputFormats = plan.extension === 'mp4' ? [MP4] : [WEBM];
  const videoInput = new Input({ source: new BlobSource(tracks.videoFile), formats: inputFormats });
  const audioInput = new Input({ source: new BlobSource(tracks.audioFile), formats: inputFormats });
  const destinationStream = await destination.createWritable();

  try {
    const [videoTrack, audioTrack] = await Promise.all([
      videoInput.getPrimaryVideoTrack(),
      audioInput.getPrimaryAudioTrack(),
    ]);
    if (!videoTrack || !audioTrack) throw new Error('The downloaded tracks could not be read.');

    const [videoCodec, audioCodec, videoConfig, audioConfig] = await Promise.all([
      videoTrack.getCodec(),
      audioTrack.getCodec(),
      videoTrack.getDecoderConfig(),
      audioTrack.getDecoderConfig(),
    ]);
    if (!videoCodec || !audioCodec) throw new Error('A downloaded codec is not supported by the local muxer.');

    const videoSource = new EncodedVideoPacketSource(videoCodec);
    const audioSource = new EncodedAudioPacketSource(audioCodec);
    const target = new StreamTarget(
      destinationStream as unknown as WritableStream<StreamTargetChunk>,
      { chunked: true, chunkSize: 4 * 1024 * 1024 },
    );
    const format = plan.extension === 'mp4'
      ? new Mp4OutputFormat({ fastStart: false })
      : new WebMOutputFormat();
    const output = new Output({ format, target });
    output.addVideoTrack(videoSource, { decoderConfig: videoConfig || undefined });
    output.addAudioTrack(audioSource, { decoderConfig: audioConfig || undefined });
    output.setMetadataTags({
      title: context.title,
      images: thumbnail ? [thumbnail] : undefined,
    });
    await output.start();

    const videoIterator = new EncodedPacketSink(videoTrack).packets()[Symbol.asyncIterator]();
    const audioIterator = new EncodedPacketSink(audioTrack).packets()[Symbol.asyncIterator]();
    let [nextVideo, nextAudio] = await Promise.all([videoIterator.next(), audioIterator.next()]);
    let lastReport = 0;

    while (!nextVideo.done || !nextAudio.done) {
      if (signal.aborted) throw signal.reason || new DOMException('Canceled', 'AbortError');
      const takeVideo = nextAudio.done
        || (!nextVideo.done && nextVideo.value.timestamp <= nextAudio.value.timestamp);
      let mediaTime = 0;
      if (takeVideo && !nextVideo.done) {
        mediaTime = nextVideo.value.timestamp;
        await videoSource.add(nextVideo.value);
        nextVideo = await videoIterator.next();
      } else if (!nextAudio.done) {
        mediaTime = nextAudio.value.timestamp;
        await audioSource.add(nextAudio.value);
        nextAudio = await audioIterator.next();
      }

      const now = performance.now();
      if (now - lastReport > 100) {
        lastReport = now;
        const mediaFraction = context.durationMs > 0 ? mediaTime / (context.durationMs / 1000) : 0;
        onProgress({
          phase: 'muxing',
          label: `Muxing locally… ${Math.min(100, Math.round(mediaFraction * 100))}%`,
          fraction: Math.min(0.99, 0.8 + mediaFraction * 0.19),
        });
      }
    }

    videoSource.close();
    audioSource.close();
    await output.finalize();
    onProgress({ phase: 'done', label: 'Saved', fraction: 1 });
  } catch (error) {
    await destinationStream.abort(error).catch(() => undefined);
    throw error;
  } finally {
    videoInput.dispose();
    audioInput.dispose();
  }
}

export async function downloadAndMux(
  context: PlayerContext,
  plan: DownloadPlan,
  signal: AbortSignal,
  onProgress: (update: ProgressUpdate) => void,
): Promise<void> {
  // Keep this first await directly inside the user's quality-button gesture.
  const destination = await chooseDestination(context, plan);
  if (plan.kind === 'audio') {
    await downloadAudioOnly(context, plan, destination, signal, onProgress);
    return;
  }
  let tracks: TemporaryTracks | null = null;
  try {
    tracks = await downloadTemporaryTracks(context, plan, signal, onProgress);
    const thumbnail = await fetchVideoThumbnail(context, signal, onProgress);
    onProgress({ phase: 'muxing', label: 'Preparing local mux…', fraction: 0.8 });
    await muxTracks(tracks, destination, context, plan, thumbnail, signal, onProgress);
  } finally {
    if (tracks) {
      await Promise.allSettled([
        tracks.root.removeEntry(tracks.videoName),
        tracks.root.removeEntry(tracks.audioName),
      ]);
    }
  }
}

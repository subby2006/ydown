import type { SabrFormat } from 'googlevideo/shared-types';

export type JsonObject = Record<string, any>;

export interface CapturedSession {
  playerResponse: JsonObject | null;
  playerVideoId: string | null;
  playerResponseCapturedAt: number | null;
  poTokenByVideoId: Map<string, string>;
  poTokenCapturedAtByVideoId: Map<string, number>;
  sabrUrlByVideoId: Map<string, string>;
  sabrUrlCapturedAtByVideoId: Map<string, number>;
  nativeSabrConfigByVideoId: Map<string, string>;
  nativeSabrPoTokenByVideoId: Map<string, string>;
  nativeSabrBodyCapturedAtByVideoId: Map<string, number>;
  nativeSabrBodyDiagnosticsByVideoId: Map<string, JsonObject>;
}

export interface DownloadPlan {
  kind: 'video' | 'audio';
  id: string;
  label: string;
  detail: string;
  extension: 'mp4' | 'webm' | 'm4a';
  mimeType: 'video/mp4' | 'video/webm' | 'audio/mp4' | 'audio/webm';
  video: SabrFormat;
  audio: SabrFormat;
  estimatedBytes: number;
}

export interface PlayerContext {
  videoId: string;
  title: string;
  thumbnailUrls: string[];
  response: JsonObject;
  serverAbrStreamingUrl: string;
  videoPlaybackUstreamerConfig: string;
  poToken?: string;
  clientInfo: {
    clientName: number;
    clientVersion: string;
    osName: string;
    osVersion: string;
    acceptLanguage: string;
    acceptRegion: string;
    screenWidthPoints: number;
    screenHeightPoints: number;
    windowWidthPoints: number;
    windowHeightPoints: number;
    screenDensityFloat: number;
    utcOffsetMinutes: string;
    timeZone: string;
  };
  durationMs: number;
  isMusic: boolean;
  plans: DownloadPlan[];
}

export interface ProgressUpdate {
  phase: 'preparing' | 'downloading' | 'muxing' | 'done';
  label: string;
  fraction: number | null;
}

declare global {
  interface Window {
    ytInitialPlayerResponse?: JsonObject;
    ytcfg?: { get?: (key: string) => unknown };
    movie_player?: { getPlayerResponse?: () => JsonObject };
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      types?: Array<{
        description?: string;
        accept: Record<string, string[]>;
      }>;
    }) => Promise<FileSystemFileHandle>;
  }
}

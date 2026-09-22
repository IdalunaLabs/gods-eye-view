export const FRAME_ENDPOINT = '/api/cctv/frame';

export const SOURCE_ENDPOINT = '/api/cctv/sources';

export const HEALTH_ENDPOINT = '/api/cctv/health';

export const MEDIA_ENDPOINT = '/api/cctv/media';

export const ACTIVE_FRAME_REFRESH_MS = 10000;

/**
 * Cache-buster bucket for a proxied motion clip. Transport for London replaces
 * an ~11s JamCam file about every 3 minutes. A shorter bucket restarts that
 * clip on every panel refresh.
 */
export const MEDIA_URL_TICK_MS = 180_000;

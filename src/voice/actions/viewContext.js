import { defaultGeospatial } from '../../search/defaults.js';
import * as Cesium from 'cesium';
import { CITY_POIS } from '../../locations.js';
import { isPickedWorldPosition } from '../../data/scenePick.js';
import { haversineKm } from './shared.js';
const serviceCaches = new WeakMap();
function cachesFor(service) {
  service.signal?.throwIfAborted();
  let caches = serviceCaches.get(service);
  if (!caches) {
    caches = {
      reverseGeocodeCache: new Map(),
      reverseGeocodeInFlight: new Map(),
      nearbyPlacesCache: new Map(),
      nearbyPlacesInFlight: new Map(),
    };
    serviceCaches.set(service, caches);
    service.signal?.addEventListener(
      'abort',
      () => {
        for (const cache of Object.values(caches)) cache.clear();
      },
      { once: true },
    );
  }
  return caches;
}
const BASEMAP_CONTEXT_WAIT_MS = 1500;
const viewTargetCache = new WeakMap();

export async function getBasemapLabelContext(
  viewer,
  service = defaultGeospatial,
  { cachedOnly = false } = {},
) {
  const { reverseGeocodeCache, nearbyPlacesCache } = cachesFor(service);
  const samples = sampleViewportCartographics(viewer);
  const cameraHeightM = viewer.camera.positionCartographic.height;
  const target = getViewTargetCartographic(viewer);
  if (!target) {
    return {
      placeLabels: [],
      streetLabels: [],
      nearbyPlaceLabels: [],
    };
  }

  const latitude = Number(Cesium.Math.toDegrees(target.latitude).toFixed(6));
  const longitude = Number(Cesium.Math.toDegrees(target.longitude).toFixed(6));
  const cachedViewportPlaces = viewportPlacesFromCache(
    samples,
    cameraHeightM,
    service,
  );
  const viewportPromise = cachedViewportPlaces
    ? Promise.resolve(cachedViewportPlaces)
    : cachedOnly
      ? Promise.resolve(null)
      : reverseGeocodeViewportSamples(samples, cameraHeightM, service);
  const placePromise = shouldReverseGeocode(cameraHeightM)
    ? cachedOnly
      ? Promise.resolve(
          reverseGeocodeCache.get(
            reverseGeocodeKey(latitude, longitude, service),
          ) || null,
        )
      : reverseGeocode(latitude, longitude, service)
    : Promise.resolve(null);
  const nearbyPromise = shouldFetchNearbyPlaces(cameraHeightM)
    ? cachedOnly
      ? Promise.resolve(
          nearbyPlacesCache.get(
            nearbyPlacesCacheKey(latitude, longitude, cameraHeightM, service),
          ) || [],
        )
      : fetchNearbyPlaces(latitude, longitude, cameraHeightM, service)
    : Promise.resolve([]);
  const [viewportPlaces, place, nearbyPlaces] = await Promise.all([
    resolveWithin(
      viewportPromise,
      BASEMAP_CONTEXT_WAIT_MS,
      cachedViewportPlaces,
    ),
    resolveWithin(placePromise, BASEMAP_CONTEXT_WAIT_MS, null),
    resolveWithin(nearbyPromise, BASEMAP_CONTEXT_WAIT_MS, []),
  ]);

  return {
    placeLabels: uniqueStrings([
      place?.formattedAddress,
      place?.locality,
      place?.region,
      place?.country,
      ...(place?.labels || []),
      ...(viewportPlaces?.visibleLabels || []),
    ]).slice(0, 24),
    streetLabels: uniqueStrings([
      ...(place?.streetLabels || []),
      ...(viewportPlaces?.streetLabels || []),
    ]).slice(0, 16),
    nearbyPlaceLabels: uniqueStrings(
      (nearbyPlaces || []).flatMap((nearbyPlace) => [
        nearbyPlace.name,
        nearbyPlace.address,
      ]),
    ).slice(0, 24),
  };
}

export function installViewTargetPrewarm(viewer) {
  if (viewer.__gevViewTargetPrewarmInstalled) return;
  viewer.__gevViewTargetPrewarmInstalled = true;
  let timer = null;
  let reportedPrewarmFailure = false;
  viewer.camera.moveEnd.addEventListener(() => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      // Belt and braces. Validating the pick is the fix; this catch exists
      // because an idle callback is an UNCAUGHT context — nothing above it can
      // handle a surprise from the scene graph, and a red console error on a
      // plain camera flight is worse than a cold cache. Reported once per
      // viewer so a repeating cause cannot spam the console.
      const warm = () => {
        try {
          getViewTargetCartographic(viewer);
        } catch (error) {
          if (reportedPrewarmFailure) return;
          reportedPrewarmFailure = true;
          console.debug(
            '[Voice] view-target prewarm skipped:',
            error?.message || error,
          );
        }
      };
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(warm, { timeout: 500 });
      } else {
        warm();
      }
    }, 120);
  });
}

export async function getBasemapContext(
  viewer,
  viewTarget = null,
  service = defaultGeospatial,
) {
  const { reverseGeocodeCache, nearbyPlacesCache } = cachesFor(service);
  const target = viewTarget;
  const samples = sampleViewportCartographics(viewer);
  const cameraCartographic = Cesium.Cartographic.fromCartesian(
    viewer.camera.positionWC,
  );
  const cameraHeightM = cameraCartographic.height;
  const viewScale = classifyViewScale(cameraHeightM);
  const cachedViewportPlaces = viewportPlacesFromCache(
    samples,
    cameraHeightM,
    service,
  );
  const viewportPlacesPromise = cachedViewportPlaces
    ? Promise.resolve(cachedViewportPlaces)
    : reverseGeocodeViewportSamples(samples, cameraHeightM, service);
  if (!target) {
    const viewportPlaces = await resolveWithin(
      viewportPlacesPromise,
      BASEMAP_CONTEXT_WAIT_MS,
      cachedViewportPlaces,
    );
    return {
      source: 'Google Photorealistic 3D Tiles / Cesium basemap',
      hasGoogle3DTiles: Boolean(window.__godsEyeView?.tileset),
      viewScale,
      viewportSamples: samples,
      viewportPlaces,
      target: null,
      place: null,
    };
  }

  const latitude = Number(Cesium.Math.toDegrees(target.latitude).toFixed(6));
  const longitude = Number(Cesium.Math.toDegrees(target.longitude).toFixed(6));
  const inferredCountry = inferCountryFromSamples(samples);
  const knownLandmarks = nearbyKnownLandmarks(
    latitude,
    longitude,
    cameraHeightM,
  );
  const fallbackPlace = coarseBasemapPlace(
    viewScale,
    latitude,
    longitude,
    inferredCountry,
  );
  const cachedPlace = shouldReverseGeocode(cameraHeightM)
    ? reverseGeocodeCache.get(
        reverseGeocodeKey(latitude, longitude, service),
      ) || null
    : null;
  const nearbyCacheKey = nearbyPlacesCacheKey(
    latitude,
    longitude,
    cameraHeightM,
    service,
  );
  const cachedNearbyPlaces =
    shouldFetchNearbyPlaces(cameraHeightM) &&
    nearbyPlacesCache.has(nearbyCacheKey)
      ? nearbyPlacesCache.get(nearbyCacheKey)
      : null;
  const placePromise =
    shouldReverseGeocode(cameraHeightM) && !cachedPlace
      ? reverseGeocode(latitude, longitude, service)
      : Promise.resolve(cachedPlace);
  const nearbyPlacesPromise =
    shouldFetchNearbyPlaces(cameraHeightM) && !cachedNearbyPlaces
      ? fetchNearbyPlaces(latitude, longitude, cameraHeightM, service)
      : Promise.resolve(cachedNearbyPlaces);
  const [viewportPlaces, resolvedPlace, resolvedNearbyPlaces] =
    await Promise.all([
      resolveWithin(
        viewportPlacesPromise,
        BASEMAP_CONTEXT_WAIT_MS,
        cachedViewportPlaces,
      ),
      resolveWithin(placePromise, BASEMAP_CONTEXT_WAIT_MS, cachedPlace),
      resolveWithin(
        nearbyPlacesPromise,
        BASEMAP_CONTEXT_WAIT_MS,
        cachedNearbyPlaces,
      ),
    ]);
  const place = resolvedPlace || fallbackPlace;
  const nearbyPlaces = resolvedNearbyPlaces || [];
  return {
    source: 'Google Photorealistic 3D Tiles / Cesium basemap',
    hasGoogle3DTiles: Boolean(window.__godsEyeView?.tileset),
    viewScale,
    viewportSamples: samples,
    viewportPlaces,
    target: {
      latitude,
      longitude,
      heightM: Math.round(target.height || 0),
    },
    knownLandmarks,
    nearbyPlaces,
    place,
  };
}

function classifyViewScale(cameraHeightM) {
  if (cameraHeightM > 12000000) return 'global';
  if (cameraHeightM > 3000000) return 'continental';
  if (cameraHeightM > 750000) return 'regional';
  if (cameraHeightM > 100000) return 'metro';
  if (cameraHeightM > 10000) return 'city';
  return 'local';
}

function shouldReverseGeocode(cameraHeightM) {
  return cameraHeightM <= 750000;
}

function shouldReverseGeocodeViewport(cameraHeightM) {
  return cameraHeightM <= 3000000;
}

function shouldFetchNearbyPlaces(cameraHeightM) {
  return cameraHeightM <= 25000;
}

function nearbyKnownLandmarks(latitude, longitude, cameraHeightM) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
  const maxDistanceKm =
    cameraHeightM <= 5000
      ? 2
      : cameraHeightM <= 50000
        ? 10
        : cameraHeightM <= 250000
          ? 35
          : 0;
  if (maxDistanceKm <= 0) return [];

  const matches = [];
  for (const [cityId, city] of Object.entries(CITY_POIS)) {
    for (let poiIndex = 0; poiIndex < city.pois.length; poiIndex++) {
      const poi = city.pois[poiIndex];
      const distanceKm = haversineKm(latitude, longitude, poi.lat, poi.lon);
      if (distanceKm > maxDistanceKm) continue;
      matches.push({
        name: poi.name,
        cityId,
        city: city.name,
        latitude: poi.lat,
        longitude: poi.lon,
        distanceKm: Number(distanceKm.toFixed(3)),
      });
    }
  }
  return matches.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 5);
}

function coarseBasemapPlace(
  viewScale,
  latitude,
  longitude,
  inferredCountry = null,
) {
  if (viewScale === 'global') {
    return {
      formattedAddress: 'Global Earth view',
      locality: null,
      region: null,
      country: null,
      precision: 'global',
      note: 'Camera is too far out for a precise street or city label; do not infer a local place from the center point.',
    };
  }
  return {
    formattedAddress: inferredCountry?.country
      ? `${viewScale[0].toUpperCase()}${viewScale.slice(1)} basemap view over ${inferredCountry.country}`
      : `${viewScale[0].toUpperCase()}${viewScale.slice(1)} basemap view centered near ${latitude.toFixed(2)}, ${longitude.toFixed(2)}`,
    locality: null,
    region: null,
    country: inferredCountry?.country || null,
    precision: viewScale,
    confidence: inferredCountry?.confidence || null,
    note: 'Camera altitude is high, so this is approximate basemap context rather than a precise address.',
  };
}

export function getViewTargetCartographic(viewer) {
  const signature = cameraViewSignature(viewer);
  const cached = viewTargetCache.get(viewer);
  if (
    cached?.signature === signature &&
    performance.now() - cached.cachedAt < 2500
  ) {
    return cached.target;
  }
  const position = getViewTargetCartesian(viewer);
  // `fromCartesian` still returns undefined for a point too near the ellipsoid
  // center to project; normalize that to the same "no target" null the callers
  // already handle for a missed pick.
  const target = position
    ? Cesium.Cartographic.fromCartesian(position) || null
    : null;
  viewTargetCache.set(viewer, {
    signature,
    target,
    cachedAt: performance.now(),
  });
  return target;
}

function cameraViewSignature(viewer) {
  const camera = viewer.camera;
  const cartographic = camera.positionCartographic;
  return [
    Cesium.Math.toDegrees(cartographic.latitude).toFixed(5),
    Cesium.Math.toDegrees(cartographic.longitude).toFixed(5),
    Math.round(cartographic.height / 2),
    camera.heading.toFixed(3),
    camera.pitch.toFixed(3),
  ].join(':');
}

/**
 * World position under the center of the viewport, or null when the view has no
 * target. Each stage of the cascade is validated before it is accepted: a depth
 * pick over empty sky can return a NaN or center-of-the-earth Cartesian, and
 * converting one of those throws deep inside Cesium. A degenerate pick is a
 * MISSED pick, so it falls through to the next stage rather than poisoning
 * every caller downstream.
 */
export function getViewTargetCartesian(viewer) {
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const width = canvas.clientWidth || canvas.width || 0;
  const height = canvas.clientHeight || canvas.height || 0;
  const center = new Cesium.Cartesian2(width / 2, height / 2);
  let position = null;

  if (scene.pickPositionSupported && typeof scene.pickPosition === 'function') {
    try {
      position = scene.pickPosition(center);
    } catch {
      position = null;
    }
  }

  if (
    !isPickedWorldPosition(position) &&
    viewer.camera &&
    typeof viewer.camera.pickEllipsoid === 'function'
  ) {
    try {
      position = viewer.camera.pickEllipsoid(center, Cesium.Ellipsoid.WGS84);
    } catch {
      position = null;
    }
  }

  if (
    !isPickedWorldPosition(position) &&
    viewer.camera &&
    typeof viewer.camera.getPickRay === 'function'
  ) {
    try {
      const ray = viewer.camera.getPickRay(center);
      position = scene.globe?.pick(ray, scene) || null;
    } catch {
      position = null;
    }
  }

  return isPickedWorldPosition(position) ? position : null;
}

function sampleViewportCartographics(viewer) {
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const width = canvas.clientWidth || canvas.width || 0;
  const height = canvas.clientHeight || canvas.height || 0;
  if (!width || !height) return [];

  const points = [
    [0.5, 0.5],
    [0.25, 0.35],
    [0.75, 0.35],
    [0.25, 0.65],
    [0.75, 0.65],
    [0.5, 0.25],
    [0.5, 0.75],
  ];

  const samples = [];
  for (const [x, y] of points) {
    const cartesian = viewer.camera.pickEllipsoid(
      new Cesium.Cartesian2(width * x, height * y),
      Cesium.Ellipsoid.WGS84,
    );
    if (!isPickedWorldPosition(cartesian)) continue;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    if (!carto) continue;
    samples.push({
      latitude: Number(Cesium.Math.toDegrees(carto.latitude).toFixed(4)),
      longitude: Number(Cesium.Math.toDegrees(carto.longitude).toFixed(4)),
    });
  }
  return samples;
}

function inferCountryFromSamples(samples) {
  if (!samples.length) return null;
  const counts = new Map();
  for (const sample of samples) {
    const country = inferCountry(sample.latitude, sample.longitude);
    if (!country) continue;
    counts.set(country, (counts.get(country) || 0) + 1);
  }
  if (!counts.size) return null;
  const [country, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    country,
    confidence: Number((count / samples.length).toFixed(2)),
    sampleCount: count,
    totalSamples: samples.length,
  };
}

function inferCountry(latitude, longitude) {
  const regions = [
    { name: 'Iran', south: 24.0, north: 40.2, west: 44.0, east: 63.5 },
    { name: 'Iraq', south: 29.0, north: 37.5, west: 38.5, east: 49.0 },
    { name: 'Turkey', south: 35.5, north: 42.5, west: 25.5, east: 45.2 },
    { name: 'Saudi Arabia', south: 16.0, north: 32.5, west: 34.0, east: 56.5 },
    { name: 'Afghanistan', south: 29.0, north: 38.8, west: 60.0, east: 75.5 },
    { name: 'Pakistan', south: 23.0, north: 37.2, west: 60.5, east: 77.5 },
    { name: 'Turkmenistan', south: 35.0, north: 42.9, west: 52.0, east: 66.8 },
    { name: 'Azerbaijan', south: 38.3, north: 41.9, west: 44.6, east: 50.8 },
    { name: 'Armenia', south: 38.7, north: 41.4, west: 43.4, east: 46.7 },
    { name: 'Japan', south: 24.0, north: 46.5, west: 122.0, east: 146.5 },
    { name: 'South Korea', south: 33.0, north: 38.8, west: 124.0, east: 132.0 },
    { name: 'North Korea', south: 37.5, north: 43.2, west: 124.0, east: 131.0 },
    { name: 'China', south: 18.0, north: 53.8, west: 73.0, east: 135.2 },
    { name: 'Russia', south: 41.0, north: 82.0, west: 19.0, east: 180.0 },
    {
      name: 'United States',
      south: 24.0,
      north: 49.8,
      west: -125.0,
      east: -66.0,
    },
  ];
  const region = regions.find(
    (item) =>
      latitude >= item.south &&
      latitude <= item.north &&
      longitude >= item.west &&
      longitude <= item.east,
  );
  return region?.name || null;
}

async function reverseGeocode(latitude, longitude, service) {
  const { reverseGeocodeCache, reverseGeocodeInFlight } = cachesFor(service);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const key = reverseGeocodeKey(latitude, longitude, service);
  if (reverseGeocodeCache.has(key)) return reverseGeocodeCache.get(key);
  if (reverseGeocodeInFlight.has(key)) return reverseGeocodeInFlight.get(key);

  const request = (async () => {
    try {
      const place =
        (await service.reverseGeocode?.(latitude, longitude)) || null;
      if (place) {
        reverseGeocodeCache.set(key, place);
        if (reverseGeocodeCache.size > 256)
          reverseGeocodeCache.delete(reverseGeocodeCache.keys().next().value);
      }
      return place;
    } catch {
      return null;
    } finally {
      reverseGeocodeInFlight.delete(key);
    }
  })();
  reverseGeocodeInFlight.set(key, request);
  return request;
}

async function reverseGeocodeViewportSamples(samples, cameraHeightM, service) {
  if (!shouldReverseGeocodeViewport(cameraHeightM) || !samples.length)
    return null;
  // At building scale, center geocoding plus Nearby Places is more precise and
  // avoids three redundant Google requests.
  if (cameraHeightM <= 10000) return null;
  const prioritySamples = [samples[0], samples[1], samples[2]].filter(Boolean);
  const places = (
    await Promise.all(
      prioritySamples.map(async (sample) => {
        const place = await reverseGeocode(
          sample.latitude,
          sample.longitude,
          service,
        );
        if (!place) return null;
        return {
          latitude: sample.latitude,
          longitude: sample.longitude,
          formattedAddress: place.formattedAddress,
          locality: place.locality,
          region: place.region,
          country: place.country,
          types: place.types,
          labels: place.labels,
          streetLabels: place.streetLabels,
        };
      }),
    )
  ).filter(Boolean);
  return summarizeViewportPlaces(places);
}

function viewportPlacesFromCache(samples, cameraHeightM, service) {
  const { reverseGeocodeCache } = cachesFor(service);
  if (
    !shouldReverseGeocodeViewport(cameraHeightM) ||
    cameraHeightM <= 10000 ||
    !samples.length
  )
    return null;
  const places = [samples[0], samples[1], samples[2]]
    .filter(Boolean)
    .flatMap((sample) => {
      const place = reverseGeocodeCache.get(
        reverseGeocodeKey(sample.latitude, sample.longitude, service),
      );
      if (!place) return [];
      return [
        {
          latitude: sample.latitude,
          longitude: sample.longitude,
          formattedAddress: place.formattedAddress,
          locality: place.locality,
          region: place.region,
          country: place.country,
          types: place.types,
          labels: place.labels,
          streetLabels: place.streetLabels,
        },
      ];
    });
  return summarizeViewportPlaces(places);
}

function summarizeViewportPlaces(places) {
  if (!places.length) return null;
  return {
    samples: places,
    dominantCountry: dominantValue(
      places.map((place) => place.country).filter(Boolean),
    ),
    dominantRegion: dominantValue(
      places.map((place) => place.region).filter(Boolean),
    ),
    dominantLocality: dominantValue(
      places.map((place) => place.locality).filter(Boolean),
    ),
    visibleLabels: uniqueStrings(
      places.flatMap((place) => place.labels || []),
    ).slice(0, 24),
    streetLabels: uniqueStrings(
      places.flatMap((place) => place.streetLabels || []),
    ).slice(0, 20),
  };
}

async function fetchNearbyPlaces(latitude, longitude, cameraHeightM, service) {
  const { nearbyPlacesCache, nearbyPlacesInFlight } = cachesFor(service);
  const radiusM = nearbyPlacesRadiusM(cameraHeightM);
  const cacheKey = nearbyPlacesCacheKey(
    latitude,
    longitude,
    cameraHeightM,
    service,
  );
  if (nearbyPlacesCache.has(cacheKey)) return nearbyPlacesCache.get(cacheKey);
  if (nearbyPlacesInFlight.has(cacheKey))
    return nearbyPlacesInFlight.get(cacheKey);

  const request = (async () => {
    try {
      const places = (
        (await service.nearby?.({ latitude, longitude, radiusM })) || []
      )
        .filter((place) => place?.name)
        .slice(0, 12);
      nearbyPlacesCache.set(cacheKey, places);
      if (nearbyPlacesCache.size > 256)
        nearbyPlacesCache.delete(nearbyPlacesCache.keys().next().value);
      return places;
    } catch {
      return [];
    } finally {
      nearbyPlacesInFlight.delete(cacheKey);
    }
  })();
  nearbyPlacesInFlight.set(cacheKey, request);
  return request;
}

function uniqueStrings(values) {
  return [
    ...new Set(values.map((value) => sanitizeLabel(value)).filter(Boolean)),
  ];
}

/**
 * Normalize a feed-sourced label (place/street/POI name from OSM, geocoding,
 * Google Places, etc.) before it enters the voice LLM's scene context.
 * Collapses newlines/control chars to single spaces and hard-caps length, so
 * crafted map data can't smuggle multi-line "instructions" into the prompt.
 * Defense-in-depth — these are reference labels, not commands.
 * @param {*} value - Raw label value.
 * @returns {string} Sanitized single-line label (max 120 chars).
 */
function sanitizeLabel(value) {
  const text = String(value || '');
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    out += code < 0x20 || code === 0x7f ? ' ' : ch; // drop control chars incl. newlines
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function cachePrecision(service) {
  return Number.isInteger(service?.cachePrecision)
    ? Math.max(3, Math.min(6, service.cachePrecision))
    : 4;
}

function reverseGeocodeKey(latitude, longitude, service) {
  return `${latitude.toFixed(cachePrecision(service))},${longitude.toFixed(cachePrecision(service))}`;
}

function nearbyPlacesCacheKey(latitude, longitude, cameraHeightM, service) {
  const radiusM = nearbyPlacesRadiusM(cameraHeightM);
  return `${latitude.toFixed(cachePrecision(service))},${longitude.toFixed(cachePrecision(service))},${radiusM}`;
}

function nearbyPlacesRadiusM(cameraHeightM) {
  if (cameraHeightM <= 1000) return 500;
  if (cameraHeightM <= 5000) return 2000;
  return 5000;
}

async function resolveWithin(promise, timeoutMs, fallback) {
  let timeout = null;
  try {
    return await Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise((resolve) => {
        timeout = window.setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) window.clearTimeout(timeout);
  }
}

function dominantValue(values) {
  if (!values.length) return null;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const [value, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    value,
    count,
    confidence: Number((count / values.length).toFixed(2)),
  };
}

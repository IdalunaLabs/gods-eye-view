import * as Cesium from 'cesium';
const COMPASS_16 = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

function compassDir(azDeg) {
  return COMPASS_16[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16];
}

function nextIssPass(viewer, dataManager, args) {
  let latDeg = Number.isFinite(args.latitude) ? args.latitude : null;
  let lonDeg = Number.isFinite(args.longitude) ? args.longitude : null;
  if (latDeg == null || lonDeg == null) {
    const carto = viewer?.camera?.positionCartographic;
    if (!carto) throw new Error('Camera position unavailable');
    latDeg = Cesium.Math.toDegrees(carto.latitude);
    lonDeg = Cesium.Math.toDegrees(carto.longitude);
  }
  const minElevDeg = Number.isFinite(args.minElevationDeg)
    ? args.minElevationDeg
    : 10;
  const result = dataManager?.layers
    ?.get('satellites')
    ?.module?.getNextIssPass?.({ latDeg, lonDeg, minElevDeg }) ?? {
    status: 'no-tle',
  };
  if (result.status === 'no-tle') {
    return {
      ok: false,
      action: 'next_iss_pass',
      error:
        'ISS orbital elements not loaded yet — enable the satellites layer once, then ask again.',
    };
  }
  if (result.status === 'none') {
    return {
      ok: false,
      action: 'next_iss_pass',
      error: `No ISS pass above ${minElevDeg}° in the next 24 hours for this location.`,
    };
  }
  const { pass } = result;
  return {
    ok: true,
    action: 'next_iss_pass',
    observer: { latitude: latDeg, longitude: lonDeg },
    riseIso: new Date(pass.riseMs).toISOString(),
    minutesFromNow: Math.round((pass.riseMs - Date.now()) / 60000),
    durationMin: Math.max(1, Math.round((pass.setMs - pass.riseMs) / 60000)),
    peakElevationDeg: Math.round(pass.maxElevDeg),
    riseDirection: compassDir(pass.riseAzDeg),
  };
}
/**
 * Execute the next_iss_pass voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'next_iss_pass';
  const { viewer, dataManager } = context;
    if (name === 'next_iss_pass') {
      return nextIssPass(viewer, dataManager, args);
    }
}

/** Voice tool handler for next_iss_pass. */
export const action = {
  name: 'next_iss_pass',
  execute,
};

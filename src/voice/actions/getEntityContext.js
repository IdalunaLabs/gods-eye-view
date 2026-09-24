import { defaultGeospatial } from '../../search/defaults.js';
import * as Cesium from 'cesium';
import {
  getContextStore,
  getSelectedEntityContext,
  isContextRecordActive,
} from '../../data/contextStore.js';
import {
  normalizeLayerId,
  clampNumber,
} from './shared.js';
import {
  getBasemapContext,
  getViewTargetCartographic,
} from './viewContext.js';
const VISIBLE_ENTITY_SHORTLIST = 64;

async function getEntityContext(
  viewer,
  dataManager,
  styleManager,
  args = {},
  service = defaultGeospatial,
) {
  const startedAt = performance.now();
  const scope = String(args.scope || 'auto').toLowerCase();
  const layerId = normalizeLayerId(args.layerId || args.layer);
  const limit = Math.round(clampNumber(args.limit, 1, 12, 5));
  const selected = selectedEntityContext(dataManager);
  const cameraHeightM = viewer.camera.positionCartographic.height;
  const viewTarget = getViewTargetCartographic(viewer);
  const scenePromise = getSceneContext(
    viewer,
    styleManager,
    dataManager,
    viewTarget,
    service,
  );
  const selectedWillBeReturned =
    selected && (scope === 'selected' || scope === 'auto');
  const visible =
    !selectedWillBeReturned && shouldScanVisibleEntities(cameraHeightM)
      ? visibleEntityContexts(viewer, dataManager, {
          layerId,
          limit,
          target: viewTarget,
        })
      : [];
  const scene = await scenePromise;

  if ((scope === 'selected' || scope === 'auto') && selected) {
    logSlowContext(startedAt, 'selected');
    return {
      ok: true,
      action: 'get_entity_context',
      scope: 'selected',
      scene,
      selected,
    };
  }

  logSlowContext(startedAt, 'in_view');
  return {
    ok: true,
    action: 'get_entity_context',
    scope: 'in_view',
    scene,
    selected: selected || null,
    visible,
    count: visible.length,
    visibleScanSkipped: !shouldScanVisibleEntities(cameraHeightM),
  };
}

function shouldScanVisibleEntities(cameraHeightM) {
  return cameraHeightM <= 100000;
}

function selectedEntityContext(dataManager) {
  const record = getSelectedEntityContext({ dataManager });
  if (!record) return null;
  return summarizeContextRecord(record, { includeProperties: true });
}

function visibleEntityContexts(
  viewer,
  dataManager,
  { layerId = null, limit = 5, target = null } = {},
) {
  const nearbyRecords = [];
  const canvas = viewer.scene.canvas;
  const width = canvas.clientWidth || canvas.width || 0;
  const height = canvas.clientHeight || canvas.height || 0;
  const centerX = width / 2;
  const centerY = height / 2;
  const targetLat = target ? Cesium.Math.toDegrees(target.latitude) : null;
  const targetLon = target ? Cesium.Math.toDegrees(target.longitude) : null;
  const store = getContextStore();
  const enabledLayerIds = new Set(
    dataManager
      .getAll()
      .filter((layer) => layer.enabled)
      .map((layer) => layer.id),
  );

  for (const record of store.entities.values()) {
    if (layerId && record.layerId !== layerId) continue;
    if (record.layerId && !enabledLayerIds.has(record.layerId)) continue;
    if (record.entity?.show === false || record.dataSource?.show === false)
      continue;
    if (!Number.isFinite(record.latitude) || !Number.isFinite(record.longitude))
      continue;
    insertNearestRecord(
      nearbyRecords,
      {
        record,
        distanceScore: target
          ? approximateCoordinateDistanceSq(
              targetLat,
              targetLon,
              record.latitude,
              record.longitude,
            )
          : 0,
      },
      VISIBLE_ENTITY_SHORTLIST,
    );
  }

  const candidates = [];
  for (const { record } of nearbyRecords) {
    const position = record.entity?.__localBaseCartesian;
    if (!position) continue;
    const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
      viewer.scene,
      position,
    );
    if (
      !screen ||
      screen.x < 0 ||
      screen.y < 0 ||
      screen.x > width ||
      screen.y > height
    )
      continue;
    const dx = screen.x - centerX;
    const dy = screen.y - centerY;
    candidates.push({
      summary: summarizeContextRecord(record, { includeProperties: true }),
      distancePx: Math.sqrt(dx * dx + dy * dy),
    });
  }

  return candidates
    .sort((a, b) => a.distancePx - b.distancePx)
    .slice(0, limit)
    .map((item) => item.summary);
}

function insertNearestRecord(records, candidate, limit) {
  if (records.length < limit) {
    records.push(candidate);
    records.sort((a, b) => a.distanceScore - b.distanceScore);
    return;
  }
  if (candidate.distanceScore >= records[records.length - 1].distanceScore)
    return;

  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (records[middle].distanceScore <= candidate.distanceScore)
      low = middle + 1;
    else high = middle;
  }
  records.splice(low, 0, candidate);
  records.pop();
}

async function getSceneContext(
  viewer,
  styleManager,
  dataManager,
  viewTarget = null,
  service = defaultGeospatial,
) {
  const cartographic = Cesium.Cartographic.fromCartesian(
    viewer.camera.positionWC,
  );
  const basemap = await getBasemapContext(viewer, viewTarget, service);
  const enabledLayers = dataManager
    .getAll()
    .filter((layer) => layer.enabled)
    .map((layer) => ({
      id: layer.id,
      name: layer.name,
      count: layer.stats?.count || 0,
      source: layer.source,
    }));
  return {
    camera: {
      latitude: Number(Cesium.Math.toDegrees(cartographic.latitude).toFixed(6)),
      longitude: Number(
        Cesium.Math.toDegrees(cartographic.longitude).toFixed(6),
      ),
      heightM: Math.round(cartographic.height),
    },
    basemap,
    style: styleManager.activeStyle || 'normal',
    enabledLayers,
  };
}

function approximateCoordinateDistanceSq(latA, lonA, latB, lonB) {
  const latDelta = latB - latA;
  const lonDelta =
    (lonB - lonA) * Math.cos(Cesium.Math.toRadians((latA + latB) / 2));
  return latDelta * latDelta + lonDelta * lonDelta;
}

function logSlowContext(startedAt, scope) {
  const durationMs = Math.round(performance.now() - startedAt);
  if (durationMs >= 500) {
    console.info(
      `[GEV Voice] ${scope} scene context completed in ${durationMs}ms`,
    );
  }
}

function summarizeEntity(viewer, entity, { includeProperties = false } = {}) {
  const now = Cesium.JulianDate.now();
  if (entity.__gevContextId) {
    const store = window.__gevContextStore;
    const record = store?.entities?.get(entity.__gevContextId);
    if (record) return summarizeContextRecord(record, { includeProperties });
  }
  const props = propertyObject(entity);
  const layerId = entity.__localLayerId || props.layerId || null;
  const tags = props.tags || {};
  const label = cleanText(
    props.name ||
      tags.name ||
      tags['name:en'] ||
      tags.official_name ||
      tags.operator ||
      props.operator ||
      entity.name ||
      layerTitle(layerId),
  );
  const position =
    entity.__localBaseCartesian ||
    entity.position?.getValue?.(now) ||
    polygonCenter(entity, now);
  const carto = position ? Cesium.Cartographic.fromCartesian(position) : null;
  return {
    id: String(entity.id || ''),
    name: label || layerTitle(layerId),
    layerId,
    layerName: layerTitle(layerId),
    latitude: carto
      ? Number(Cesium.Math.toDegrees(carto.latitude).toFixed(6))
      : null,
    longitude: carto
      ? Number(Cesium.Math.toDegrees(carto.longitude).toFixed(6))
      : null,
    properties: includeProperties ? compactProperties(props) : undefined,
  };
}

function summarizeContextRecord(record, { includeProperties = false } = {}) {
  return {
    id: String(record.id || ''),
    name:
      cleanText(record.label || record.properties?.name) ||
      layerTitle(record.layerId),
    layerId: record.layerId || null,
    layerName: record.layerName || layerTitle(record.layerId),
    source: record.source || null,
    latitude: record.latitude ?? null,
    longitude: record.longitude ?? null,
    properties: includeProperties
      ? compactProperties(record.properties || {})
      : undefined,
    active: isContextRecordActive(record),
  };
}

function polygonCenter(entity, now) {
  const hierarchy = entity.polygon?.hierarchy?.getValue?.(now);
  const positions = hierarchy?.positions;
  if (!positions?.length) return null;
  return Cesium.BoundingSphere.fromPoints(positions).center;
}

function propertyObject(entity) {
  const raw = entity?.properties?.getValue?.(Cesium.JulianDate.now()) || {};
  return unwrapProperties(raw);
}

function unwrapProperties(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(unwrapProperties);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] =
      entry && typeof entry.getValue === 'function'
        ? unwrapProperties(entry.getValue(Cesium.JulianDate.now()))
        : unwrapProperties(entry);
  }
  return out;
}

function compactProperties(props) {
  const preferredKeys = [
    'name',
    'operator',
    'owner',
    'brand',
    'addr:city',
    'addr:state',
    'country',
    'capacity',
    'output',
    'osm_id',
    'source',
  ];
  const flat = {
    ...props,
    ...(props.tags && typeof props.tags === 'object' ? props.tags : {}),
  };
  const result = {};
  for (const key of preferredKeys) {
    const value = cleanText(flat[key]);
    if (value) result[key] = value;
  }
  for (const [key, value] of Object.entries(flat)) {
    if (Object.keys(result).length >= 12) break;
    if (key === 'tags' || result[key] !== undefined) continue;
    const text = cleanText(value);
    if (text) result[key] = text;
  }
  return result;
}

function cleanText(value) {
  if (value == null || typeof value === 'object') return '';
  const text = String(value).trim();
  if (!text || text === 'undefined' || text === 'null') return '';
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function layerTitle(layerId) {
  if (layerId === 'local-datacenters') return 'Datacenter';
  if (layerId === 'local-dams') return 'Dam';
  if (layerId === 'telegeography-submarine-cables') return 'Submarine Cable';
  if (layerId === 'local-firms') return 'Active Fire';
  return layerId || 'Entity';
}
/**
 * Execute the get_entity_context voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'get_entity_context';
  const { viewer, styleManager, dataManager, placeSearch } = context;
    if (name === 'get_entity_context') {
      return getEntityContext(
        viewer,
        dataManager,
        styleManager,
        args,
        placeSearch,
      );
    }
}

/** Voice tool handler for get_entity_context. */
export const action = {
  name: 'get_entity_context',
  execute,
};

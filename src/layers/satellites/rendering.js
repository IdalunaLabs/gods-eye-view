import * as Cesium from 'cesium';
import { gstime } from 'satellite.js';
import { ISS_NORAD, POSITION_UPDATE_MS, RING_ROTATION_MS } from './policy.js';
import { PROPAGATION_STRIDE } from './propagation.js';
import { createPropagationClient } from './propagationClient.js';

export function createRendering({
  state: layerState,
  services,
  parts,
  source,
}) {
  const {
    focusNowMs,
    getFocusTarget,
    focusPassIsNeeded,
    nearFarScalarValueAtDistance,
    advanceSpriteFocus,
    focusAlphaNeedsWrite,
  } = services.focus;
  const fleet = createPropagationClient();

  /**
   * Show orbital path for a satellite.
   *
   * RING FLICKER FIX: this is a one-instance Cesium.Primitive built
   * synchronously ONCE (asynchronous: false), then re-aligned to current GMST
   * each tick via its modelMatrix. The previous Entity-polyline approach
   * rebuilt geometry ASYNCHRONOUSLY on every positions assignment, which made
   * both the selected ring and the ISS ring blink once per second while the
   * rebuild was in flight. A rigid Z-rotation needs no rebuild at all.
   *
   * Why not a CallbackProperty entity (dynamic mode)? Verified in Cesium
   * 1.138 source: the dynamic polyline updater renders through a shared
   * PolylineCollection and applies only the fill material —
   * `depthFailMaterial` is silently dropped, losing the dimmed behind-Earth
   * segment. The Primitive keeps it via depthFailAppearance + the per-instance
   * depthFailColor attribute (same mechanism the entity STATIC batch uses):
   * bright where above the horizon, dimmed where behind the globe.
   */

  function _showOrbitPath(noradId, color) {
    if (layerState._orbitPaths.has(noradId)) return; // already showing

    const sat = layerState._catalog.get(noradId);
    if (!sat || !layerState._viewer) return;

    const bakeDate = new Date();
    const basePositions = parts.orbits.computeOrbitPath(sat.satrec, bakeDate);
    if (basePositions.length < 2) return;

    const pathColor = color || Cesium.Color.CYAN;

    const primitive = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.PolylineGeometry({
          positions: basePositions,
          width: noradId === ISS_NORAD ? 2.5 : 2.0,
          vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            pathColor.withAlpha(0.6),
          ),
          depthFailColor: Cesium.ColorGeometryInstanceAttribute.fromColor(
            pathColor.withAlpha(0.35),
          ),
        },
      }),
      appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
      depthFailAppearance: new Cesium.PolylineColorAppearance({
        translucent: true,
      }),
      asynchronous: false, // build this frame — no async-rebuild blink window
      allowPicking: false, // ring clicks fall through to satellites/deselect
    });
    layerState._viewer.scene.primitives.add(primitive);

    layerState._orbitPaths.set(noradId, {
      primitive,
      // Same Date object as computeOrbitPath's internal fixedGmst → identical
      // GMST value (gstime is pure), so delta starts at exactly 0 and the
      // initial identity modelMatrix is correct until the first ring tick.
      gmstAtBake: gstime(bakeDate),
    });
  }

  /**
   * Rotate every baked orbit ring from its bake-time ECEF snapshot to current
   * GMST (WS-D1). The baked ring is an inertial-frame snapshot frozen at
   * gmstAtBake; the live dot lives in true rotating-frame ECEF, so without this
   * the dot slides west off the ring at Earth-rotation rate (~0.25°/min).
   *
   * Sign derivation: a point fixed in inertial space keeps its right ascension
   * α, so its ECEF longitude λ = α − gmst DECREASES by ΔGMST as time advances
   * (it drifts WEST). Cesium.Matrix3.fromRotationZ(θ) rotates +X toward +Y,
   * i.e. INCREASES longitude by θ — so we rotate the baked points by −ΔGMST.
   * Mental check: ISS baked over Austin at t0; 10 min later Austin has rotated
   * east under the (inertial) ring, so the ring must sit further WEST in ECEF.
   *
   * Wraparound: gstime returns radians in [0, 2π), so the raw difference can be
   * off from the continuous ΔGMST — but only by exact multiples of 2π, which a
   * rotation cannot distinguish. Tiny negative deltas right after bake are
   * likewise harmless. No unwrapping needed.
   *
   * No SGP4 here — the rotation is applied as the ring primitive's modelMatrix
   * (exact compensation; WGS84 is rotationally symmetric about Z, so rotating
   * the baked curve rigidly equals rebaking from rotated points). modelMatrix
   * updates are synchronous uniforms — no geometry rebuild, no flicker. Post-
   * creation modelMatrix changes are supported for one-instance primitives in
   * 3D mode, which these rings are. In-place mutation is safe: Primitive.update
   * diffs modelMatrix against an internal clone.
   * @param {Date} nowDate Epoch used for current GMST.
   */

  function _updateOrbitPathRotations(nowDate) {
    if (layerState._orbitPaths.size === 0) return;

    const liveGmst = gstime(nowDate);
    const fleetGmst = layerState._fleetGmst;
    for (const [noradId, path] of layerState._orbitPaths) {
      if (!path.primitive) continue;
      const gmst =
        noradId === layerState._trackedNorad || !Number.isFinite(fleetGmst)
          ? liveGmst
          : fleetGmst;
      parts.orbits.orbitFrameModelMatrix(
        path.gmstAtBake,
        nowDate,
        path.primitive.modelMatrix,
        gmst,
      );
    }
  }

  /**
   * Remove orbital path for a satellite.
   */

  function _hideOrbitPath(noradId) {
    const path = layerState._orbitPaths.get(noradId);
    if (path) {
      if (layerState._viewer)
        layerState._viewer.scene.primitives.remove(path.primitive); // remove() destroys
      layerState._orbitPaths.delete(noradId);
    }
  }

  /**
   * Reload the fleet worker from the current catalog. Indexes stay aligned with
   * the buffer so a later sample can update points without another TLE parse.
   */

  function _syncFleetPropagation() {
    const records = [];
    let index = 0;
    for (const [id, sat] of layerState._catalog) {
      sat.fleetIndex = index;
      records.push({
        id,
        line1: sat.line1,
        line2: sat.line2,
        satrec: sat.satrec,
      });
      index += 1;
    }
    layerState._fleetBuffer = null;
    layerState._fleetGmst = null;
    fleet.load(records, layerState._catalogRevision);
  }

  /** Drop the worker when the layer is reinitialized or destroyed. */
  function _resetFleetPropagation() {
    fleet.reset();
    layerState._fleetBuffer = null;
    layerState._fleetGmst = null;
    layerState._appliedFleetGeneration = 0;
    layerState._appliedFleetSequence = 0;
  }

  function _writeFleetPoint(noradId, buffer, index) {
    const base = index * PROPAGATION_STRIDE;
    if (buffer[base + 3] !== 1) return false;
    const point = layerState._points.get(noradId);
    if (!point) return false;
    point.position = new Cesium.Cartesian3(
      buffer[base],
      buffer[base + 1],
      buffer[base + 2],
    );
    return true;
  }

  /**
   * Copy one completed ECEF sample onto core points and remember it for the
   * dense slice. Untracked rings lock to this sample's GMST.
   * @param {object} sample
   * @param {number} nowMs
   */

  function _applyFleetSample(sample, nowMs) {
    const buffer = sample.buffer;
    const tracked = layerState._trackedNorad;
    for (let i = 0; i < sample.ids.length; i += 1) {
      const noradId = sample.ids[i];
      if (noradId === tracked) continue;
      if (layerState._catalog.get(noradId)?.group === 'dense') continue;
      _writeFleetPoint(noradId, buffer, i);
    }
    layerState._fleetBuffer = buffer;
    layerState._fleetGmst = sample.gmst;
    layerState._appliedFleetGeneration = sample.generation;
    layerState._appliedFleetSequence = sample.sequence;
    if (layerState._params.showOrbits) {
      _updateOrbitPathRotations(new Date(nowMs));
    }
  }

  function _fleetCoversDense() {
    return Boolean(
      layerState._fleetBuffer && fleet.coversAll(layerState._denseIds),
    );
  }

  function _applyFreshFleetSample(nowMs) {
    const sample = fleet.latest();
    if (
      !sample ||
      (sample.generation === layerState._appliedFleetGeneration &&
        sample.sequence === layerState._appliedFleetSequence)
    ) {
      return;
    }
    _applyFleetSample(sample, nowMs);
  }

  /**
   * Shared scene.preRender tick (single definition for init + enable):
   * - core fleet propagation at 200ms-tracked / 1s-idle cadence,
   * - dense extras on a per-frame round-robin budget,
   * - tracked satellite's point primitive per frame (WS-D2),
   * - orbit ring GMST re-alignment every ~1s (WS-D1).
   */

  function _preRenderTick() {
    if (!layerState._enabled) return;
    const now = focusNowMs(Date.now());

    const interval = layerState._trackedNorad ? 200 : POSITION_UPDATE_MS;
    // Space Missions keeps this layer enabled for TLE lookup while deliberately
    // hiding its standalone fleet. Do not rebuild hidden point buffers on the
    // one-second propagation cadence: that GPU upload presented as a periodic
    // whole-globe pulse even though the camera remained stationary.
    if (layerState._params.showPoints) {
      if (fleet.boundRevision() !== layerState._catalogRevision) {
        _syncFleetPropagation();
      }
      // Publish any sample already in hand before the next request can transfer
      // its buffer, then publish again so a synchronous fallback is visible
      // this frame. A late worker keeps the previous sample.
      _applyFreshFleetSample(now);
      fleet.poll();
      if (
        now - layerState._lastPropagation >= interval &&
        fleet.propagate(now)
      ) {
        layerState._lastPropagation = now;
      }
      _applyFreshFleetSample(now);
    }

    if (layerState._params.showPoints) parts.catalog._propagateDenseChunk();

    // Keep the tracked dot on the per-frame epoch shared with label + camera —
    // runs after the fleet sample so the per-frame sample wins over the batch.
    if (layerState._trackedNorad !== null) {
      const pos = parts.tracking._getTrackedFramePosition();
      const point = layerState._points.get(layerState._trackedNorad);
      if (pos && point) {
        point.position = layerState._trackedFrameCartesian; // primitive setter clones
      }
    }

    _updatePointFocus(now);

    // Hidden standalone orbit primitives do not need GMST matrix writes while
    // Space Missions draws the selected mission orbit itself.
    if (
      layerState._params.showOrbits &&
      now - layerState._lastRingRotation >= RING_ROTATION_MS
    ) {
      _updateOrbitPathRotations(new Date(now));
      layerState._lastRingRotation = now;
    }
  }

  /** Focus alpha for satellite points, inside the existing shared preRender tick. */

  function _updatePointFocus(nowMs) {
    const target = getFocusTarget();
    if (
      !layerState._params.showPoints ||
      !focusPassIsNeeded(target, layerState._activeFocusCount)
    )
      return;
    if (nowMs - layerState._lastFocusUpdate < 80) return;
    layerState._lastFocusUpdate = nowMs;
    const scene = layerState._viewer.scene;
    const camera = layerState._viewer.camera;
    const result = applySatellitePointFocusDeemphasis({
      points: layerState._points,
      trackedId: layerState._trackedNorad,
      target,
      previousActiveCount: layerState._activeFocusCount,
      nowMs,
      screenPositionFor: (position) =>
        Cesium.SceneTransforms.worldToWindowCoordinates(
          scene,
          position,
          layerState._scratchFocusScreen,
        ),
      cameraDistanceFor: (position) =>
        Cesium.Cartesian3.distance(camera.positionWC, position),
      baseColorFor: (noradId) =>
        parts.controls._pointStyleFor(
          noradId,
          layerState._catalog.get(noradId)?.group,
        ).color,
    });
    layerState._activeFocusCount = result.activeCount;
  }

  /**
   * Apply the gated satellite-point focus pass through the production color path.
   * @param {object} input
   * @returns {{writes:number,transitioning:boolean,activeCount:number,ran:boolean}}
   */

  function applySatellitePointFocusDeemphasis({
    points,
    trackedId,
    target,
    previousActiveCount = 0,
    nowMs,
    screenPositionFor,
    cameraDistanceFor,
    baseColorFor,
    params,
  }) {
    if (!focusPassIsNeeded(target, previousActiveCount)) {
      return { writes: 0, transitioning: false, activeCount: 0, ran: false };
    }
    let writes = 0;
    let transitioning = false;
    let activeCount = 0;
    for (const [noradId, point] of points || []) {
      if (noradId === trackedId || !point?.position) continue;
      const cameraDistance = cameraDistanceFor(point.position);
      const distanceScale = nearFarScalarValueAtDistance(
        point.scaleByDistance,
        cameraDistance,
      );
      const halfExtentPx = (point.pixelSize || 5) * distanceScale * 0.5;
      const focus = advanceSpriteFocus(point, {
        // Hidden points still release toward identity, preventing stale dim
        // alpha if a catalog/presentation toggle later makes them visible.
        screenPosition:
          point.show === false ? null : screenPositionFor(point.position),
        cameraDistance,
        nowMs,
        target,
        params,
        spriteHalfWidthPx: halfExtentPx,
        spriteHalfHeightPx: halfExtentPx,
      });
      transitioning ||= focus.transitioning;
      if (focus.active) activeCount += 1;
      const base = baseColorFor(noradId);
      const alpha = base.alpha * focus.factor;
      if (focusAlphaNeedsWrite(point.color?.alpha, alpha, params)) {
        // Point stays continuously present at the non-zero emphasis floor; its
        // own alpha yields around the tracked target, independent of draw order.
        point.color = base.withAlpha(alpha);
        writes += 1;
      }
    }
    return { writes, transitioning, activeCount, ran: true };
  }
  return {
    _showOrbitPath,
    _updateOrbitPathRotations,
    _hideOrbitPath,
    _syncFleetPropagation,
    _resetFleetPropagation,
    _fleetCoversDense,
    _preRenderTick,
    _updatePointFocus,
    applySatellitePointFocusDeemphasis,
  };
}

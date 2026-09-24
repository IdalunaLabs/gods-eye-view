# Fusion alerts

Fusion correlates positions the globe has already loaded. It does not fetch,
and it does not claim intent. The portable core lives in `src/fusion/` and is
exported as `gods-eye-view/fusion`. The panel adapter in `src/ui/alertsPanel.js`
is the only fusion UI that touches the DOM. `src/app/fusionAlerts.js` wires the
engine to the same `getAnalystRecords` accessors the analyst engine uses.

## Spatial index

`createSpatialIndex({ cellDegrees, capacity })` stores coordinates in growable
`Float64Array`s and keeps each cell's slot list in an `Int32Array`. Latitude
cells clamp at the poles so ±90° stays in the last in-range row. Longitude
wraps into `[-180, 180)`, and +180° shares the antimeridian cell with −180°.
A radius query that reaches a pole scans every longitude. `queryBbox` treats
`west > east` as an antimeridian span, and a span of 360° or more as the full
circle.

The spatial-index test inserts 10k points and runs 1k radius queries, and
prints both times. A quiet run on this machine was about 6 ms to insert and
about 6 ms to query at a 1° cell; a loaded machine is slower.

## Engine

`createFusionEngine` samples enabled detectors on a `setTimeout` cadence
(default 5 s). Nothing is registered with the render governor's continuous
hold. When the published list changes, the app asks for one
`governorRequestRender('fusion-alerts')`.

An alert must be present on two consecutive passes before it is published, and
it drops after three consecutive misses. Turning a detector off drops its
alerts immediately. Turning every detector off cancels the timer; no pass runs.

Flags default to convergence and dark-period on, loiter and hotspot off. They
persist through an injected storage port under
`godsEyeView.v6.fusionDetectors`. The browser adapter uses `localStorage`.

Each pass reads at most the analyst snapshot (default 2,000 records per layer).
FIRMS truncation keeps the strongest detections, so a weak cluster can be
absent. Aircraft without a layer track get a per-id ring of the last 8 fusion
samples. Vessels that leave the feed stay in memory for up to six hours so a
reporting gap can be seen; the live AIS analyst record does not include
navigational status, so that field is used only when a record actually carries
it.

At most 50 alerts are kept per detector per pass.

## Detectors

| Detector | Default | Gate |
| --- | --- | --- |
| `convergence` | on | Dead-reckoned closest approach inside 10 min and under 2 km, and still closing |
| `dark-period` | on | No report for more than 20 min after the last fixes showed motion |
| `loiter` | off | Last 8 positions inside 3 km of their centroid, airborne, faster than 40 m/s |
| `hotspot-proximity` | off | Airborne aircraft within 15 km of a FIRMS cluster or a recent M5+ earthquake |

Convergence skips ground or parked aircraft (on ground, or slower than 15 m/s,
or missing a heading) and parked vessels (under 0.5 kt, missing a course, or
AIS status matching anchored, moored, or aground).

Terminal-area heuristic: two aircraft both below 914 m (about 3,000 ft) and
currently under 15 km apart are skipped. Arrival and departure streams
routinely pass inside the closure gate there. This is not an airport boundary
and not an ATC check.

Vertical gate: when both aircraft have altitudes and they differ by more than
610 m (about 2,000 ft), the pair is skipped. If either altitude is missing the
gate is not applied, and the explanation says so. Projection is constant
heading and speed on a local flat plane.

Dark period has no shoreline model. "Open water" means the retained samples
showed speed of at least 1 kt or at least 0.3 km of travel, and status was not
moored, anchored, or aground. A gap is a missing report.

Loiter uses the layer track when one is attached (`positions` or `track` on
the analyst record). Otherwise it uses the engine ring. A tight cluster is
not a holding clearance.

Hotspot clusters link FIRMS points within 5 km until a component has at least
3 detections. Earthquakes need magnitude ≥ 5 and an origin time inside the
last hour. On-ground aircraft are skipped. Proximity is not a fire-behavior
or damage model.

## Honesty

Every alert carries `confidence` in `[0, 1]` and an `explanation` that names
the gate and the limit. Severity is `info`, `watch`, or `warn`. Convergence
is `warn` inside 0.5 km or 2 min, otherwise `watch`. Loiter is `info`. A dark
gap of 60 min or more is `warn`. A hotspot inside 5 km, or an earthquake of
M6.5 or more, is `warn`.

## Analyst

`analystEngine` answers alert questions without a new voice tool:

- `question`: "any convergences right now?", "what alerts are active?",
  "is anything circling near Texas?"
- `intent`: `convergence`, `loiter`, `dark-period`, `hotspot-proximity`, `alerts`
- `filters: [{ field: 'alertKind', op: 'eq', value: 'convergence' }]` — the
  existing `analyst_query` schema already forwards `field` as an open string

A named place uses the same region ring as other analyst queries. An
unresolved place is an error, not an empty success. If fusion is not running,
the answer says so.

## UI

The Alerts panel is the first section of the right rail, with the same collapse
chrome as the other panels. Rows are newest first: kind icon, severity colour,
entities, explanation, age. Clicking a row uses the shell navigation owner:
flights and military tracks call `trackById`; a vessel is selected and the
camera flies to the last known position; other entities fly to the alert
position. Detector toggles sit in the footer.

The intel HUD paints `#hud-fusion-alerts` in the top bar when its count is
above zero. The count is also in the panel header, which stays available when
the HUD is hidden.

# Deployment

God's Eye View can run as a single Node process that serves the built
application and the same local data-provider routes used in development.
`npm start` is that process. Vite preview remains a local check of a build; it
is not this server.

Browser keys (`GOOGLE_MAPS_API_KEY` and `CESIUM_ION_TOKEN`) are embedded in
the client bundle at build time. They are public by design. Restrict the Google
key by HTTP referrer and API, and use a Cesium ion `assets:read` token with URL
restrictions. Changing either value requires a rebuild. Every other credential
stays in the server environment and is read when the process starts.

## Node

```bash
npm ci
npm run build
npm start
```

The server listens on `localhost:4173` unless `HOST` and `PORT` are set. With
`GEV_IN_CONTAINER=1` and no `HOST`, it listens on `0.0.0.0:4173`. Optional
server keys live in the repo-root `.env` (copy `.env.example`). Variables
already set in the environment win, including empty values. `GET /healthz`
returns `{ "ok": true, "version", "uptimeSeconds" }`.

Provider Settings and `/api/setup/*` are not mounted. Unknown `/api/*` paths
return JSON `{ "error": "Unknown API route" }`. Application paths that are not
files fall back to `index.html`. Hashed files under `assets/` and the copied
Cesium tree under `cesium/` are cached for a year and marked immutable.
`index.html` is `no-cache`.

Disk caches that providers write under `.gev-cache` (CelesTrak TLEs, terrain
heights, TomTom tiles and budget, FIRMS, Launch Library, adsbdb, Overpass, and
military-installation payloads) follow `GEV_CACHE_DIR` when it is set. The
process points `.gev-cache` at that directory. Unset, the cache stays
`.gev-cache` in the working directory, which `npm start` sets to the
repository root.

`SIGTERM` and `SIGINT` stop new connections, close sockets, and run provider
cleanup (including the AIS websocket).

## Docker

The `Dockerfile` is a multi-stage build. The builder runs `npm ci` and
`npm run build`. The runtime image installs production dependencies only, copies
`dist/`, `server/`, `src/`, `config/`, and `scripts/`, and runs as a non-root
user. `src/` and `scripts/` are required because provider modules import them
directly. `public/` is copied into `dist/` by the build and is not needed at
runtime.

```bash
docker build \
  --build-arg GOOGLE_MAPS_API_KEY="$GOOGLE_MAPS_API_KEY" \
  --build-arg CESIUM_ION_TOKEN="$CESIUM_ION_TOKEN" \
  -t gods-eye-view .
docker run --rm -p 4173:4173 --env-file .env \
  -e GEV_CACHE_DIR=/var/cache/gev \
  -v gev-cache:/var/cache/gev \
  gods-eye-view
```

The runtime image sets `GEV_IN_CONTAINER=1` and `NODE_ENV=production`, exposes
4173, and health-checks `/healthz` with Node (no curl or wget).

Compose reads build args from the project `.env` and passes the same file into
the container:

```bash
cp .env.example .env
docker compose up --build
```

The named volume `gev-cache` is mounted at `/var/cache/gev`.

`ws` is a production dependency because the AIS provider loads it at runtime.
`npm ci --omit=dev` would otherwise omit it and the live vessel feed would stay
off.

## Reverse proxy

Terminate TLS at the proxy and forward plain HTTP to the Node process. The
per-IP limiters in `server/providers/common/rate-limit.js` use the socket
address only. They do not trust `X-Forwarded-For` or any other client-supplied
forwarding header. Behind one proxy, every visitor shares that proxy's address,
so the in-process limits collapse to a single bucket. Keep OpenAI and Google
budget caps at the provider. Do not publish the process without the rate-limit
variables below.

## Render and Fly

`render.yaml` is a Render Blueprint for the Dockerfile. Create the service from
the blueprint, set the public browser keys before the first build so Render can
pass them into the image build, and set private keys as secret env vars. The
disk at `/var/cache/gev` needs a paid single-instance web service. Changing a
browser key requires a new deploy.

`fly.toml` is a Fly app template. Create a volume named `gev_cache`, set
private keys with `fly secrets set`, and deploy with the public keys as build
args:

```bash
fly deploy \
  --build-arg GOOGLE_MAPS_API_KEY="$GOOGLE_MAPS_API_KEY" \
  --build-arg CESIUM_ION_TOKEN="$CESIUM_ION_TOKEN"
```

Fly terminates TLS. The same socket-address rate-limit limitation applies.

## Before you expose it

- Bind loopback unless you intend to publish the process. A non-loopback bind
  without `GEV_RATELIMIT_OPENAI_PER_MIN` and `GEV_RATELIMIT_GOOGLE_PER_MIN`
  logs a warning. Those limits are per IP, in memory, and reset on restart.
  They are not billing caps.
- Restrict `GOOGLE_MAPS_API_KEY` (HTTP referrer plus the client APIs) and
  `CESIUM_ION_TOKEN` (URL-restricted `assets:read`). Split
  `GOOGLE_MAPS_SERVER_API_KEY` when you can IP-restrict Places and Street View.
- Leave `OPENAI_API_KEY`, `AISSTREAM_API_KEY`, OpenSky client credentials,
  `FIRMS_MAP_KEY`, `TOMTOM_API_KEY`, and `LL2_API_TOKEN` in the server
  environment only. Never prefix them with `VITE_`.
- Do not commit `.env`. Provider Settings cannot edit it in this server; change
  the file or the environment and restart.
- Put a reviewed authenticating proxy in front of any host that is not a
  private network. Provider quotas are the spend backstop.
- Read [SECURITY.md](../SECURITY.md) before binding anything other than
  localhost.

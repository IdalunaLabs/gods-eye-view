# God's Eye View production image.
# Browser keys below are public and must be URL-restricted. They are baked into
# the client bundle in the build stage only. Rebuild to change them.

FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
ENV PUPPETEER_SKIP_DOWNLOAD=1
RUN npm ci

COPY . .

ARG GOOGLE_MAPS_API_KEY
ARG CESIUM_ION_TOKEN
ENV GOOGLE_MAPS_API_KEY=${GOOGLE_MAPS_API_KEY}
ENV CESIUM_ION_TOKEN=${CESIUM_ION_TOKEN}

RUN npm run build

FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    GEV_IN_CONTAINER=1 \
    GEV_CACHE_DIR=/var/cache/gev \
    HOST=0.0.0.0 \
    PORT=4173 \
    PUPPETEER_SKIP_DOWNLOAD=1

RUN addgroup -S gev \
    && adduser -S gev -G gev \
    && mkdir -p /var/cache/gev \
    && chown gev:gev /var/cache/gev

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server
COPY src ./src
COPY config ./config
COPY scripts ./scripts

RUN chown -R gev:gev /app
USER gev

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/healthz').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server/standalone/production.js"]

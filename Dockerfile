# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 ships prebuilt binaries for linux x64/arm64 and loads them first, so skip its
# node-gyp fallback (the slim image has no compiler), then prove the binary loads on this platform.
RUN npm ci --ignore-scripts \
 && node -e "new (require('better-sqlite3'))(':memory:').prepare('select sqlite_version() v').get()"
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DB_PATH=/data/hive.db
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# `hive-admin` on PATH: docker compose exec hive hive-admin invite --note Bob
RUN chmod +x dist/cli.js && ln -s /app/dist/cli.js /usr/local/bin/hive-admin \
 && mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

# Rolo — single-container deploy (SPEC §13). Build:  docker compose build
# The only state is the ./data volume (SQLite, attachments, backups).

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: better-sqlite3 ships prebuilt bindings; skipping the
# node-gyp step means no C++ toolchain in the image (see CLAUDE.md).
RUN npm ci --ignore-scripts

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Migrations apply on boot (src/instrumentation.ts) from this path.
COPY --from=build /app/src/db/migrations ./src/db/migrations
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
VOLUME /app/data
CMD ["node", "server.js"]

# ---- build stage: installs the production dependencies ----
FROM node:20-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ---- web stage: builds the React + Tailwind + TypeScript UI into /public ----
FROM node:20-bookworm AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web ./
RUN npm run build

# ---- runtime stage: slim image, no compilers ----
FROM node:20-bookworm-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY backend/app/migrations ./backend/app/migrations
COPY certs ./certs
COPY --from=web /app/public ./public
# Inside the container the app listens on all interfaces; it refuses to start without APP_PASSWORD (see src/bind.js).
# Publish the port to localhost only unless a TLS reverse proxy fronts it (see docker-compose.yml, docs/DEPLOYMENT.md).
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]

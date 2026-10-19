FROM docker.io/library/node:22-slim AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json frontend/
RUN npm ci --prefix frontend
COPY frontend/tsconfig.json frontend/vite.config.ts frontend/
COPY frontend/index.html frontend/studio.html frontend/setup.html frontend/status.html frontend/new-series.html frontend/meter.html frontend/
COPY frontend/public frontend/public
COPY frontend/src frontend/src
WORKDIR /app/frontend
RUN npx tsc --noEmit && npx vite build

FROM docker.io/library/nginx:1.27-alpine
COPY docker/frontend/default.conf.template /etc/nginx/templates/default.conf.template
# Vite writes the production dist to /app/src/player/public (frontend build.outDir).
COPY --from=build /app/src/player/public/ /usr/share/nginx/html/
ENV BACKEND_URL=http://backend:8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

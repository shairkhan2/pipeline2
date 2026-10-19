FROM docker.io/library/node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY remotion-studio/package.json remotion-studio/package-lock.json ./remotion-studio/
RUN npm ci --prefix remotion-studio

FROM docker.io/library/node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates chromium curl ffmpeg fonts-dejavu-core fonts-noto-color-emoji \
    python3 python3-venv openssh-client rsync util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && ARCH="$(dpkg --print-architecture)" \
    && SBX_ARCH="$( [ "$ARCH" = "arm64" ] && echo "arm64" || echo "amd64" )" \
    && curl -fsSL "https://github.com/docker/sbx-releases/releases/latest/download/DockerSandboxes-linux-${SBX_ARCH}.tar.gz" \
       | tar -xz -C /usr/local/bin --strip-components=1 docker-sbx/sbx \
    && chmod 0755 /usr/local/bin/sbx \
    && python3 -m venv /opt/tts \
    && /opt/tts/bin/pip install --no-cache-dir edge-tts==7.2.3
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/remotion-studio/node_modules ./remotion-studio/node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src/ ./src/
COPY remotion-studio/ ./remotion-studio/
COPY tools/ ./tools/
COPY cloud-kit/ ./cloud-kit/
RUN rm -rf src/player/public \
    && mkdir -p /data/series /data/out/jobs /data/out/config /data/thumbnails /data/auth /app/remotion-studio/public \
    && chown -R node:node /data /app/remotion-studio
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 PLAYER_API_ONLY=1 \
    PATH="/opt/tts/bin:${PATH}" \
    MANHWA_SERIES_ROOT=/data/series MANHWA_OUT_DIR=/data/out MANHWA_JOBS_DIR=/data/out/jobs \
    MANHWA_THUMBS_ROOT=/data/thumbnails PIPELINE_LOG=/data/out/pipeline.log \
    MANHWA_LANE_CONFIG=/data/out/lanes.json MANHWA_STUDIO=/app/remotion-studio \
    PLAYER_HTPASSWD=/run/secrets/player_htpasswd PLAYER_SECRET_FILE=/data/auth/session.key \
    PLAYER_TEMP_USERS=/data/auth/temp-users.json EDGE_TTS_PYTHON=/opt/tts/bin/python \
    REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/player/server.ts"]

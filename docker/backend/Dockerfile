FROM docker.io/library/node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY remotion-studio/package.json remotion-studio/package-lock.json ./remotion-studio/
RUN npm ci --prefix remotion-studio

FROM docker.io/library/node:22-bookworm-slim AS panelcleaner
# Bubble cleaner: VoxelCubes/PanelCleaner (CPU torch), pinned source + verified models.
ARG PCLEANER_COMMIT=0afa21fd6caab5bee0ab8ef51a5a19fc4bd9dda3
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/panelcleaner/venv \
    && /opt/panelcleaner/venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
    && /opt/panelcleaner/venv/bin/pip install --no-cache-dir \
       --extra-index-url https://download.pytorch.org/whl/cpu \
       torch==2.14.1+cpu torchvision==0.29.1+cpu \
       opencv-python-headless==5.0.0.93 numpy==2.4.6 scipy==1.17.1 pillow==12.3.0 \
       pyclipper==1.4.0 shapely==2.2.0 loguru==0.7.3 requests==2.34.2 tqdm==4.70.1 \
       psutil==7.2.2 attrs==26.1.0 colorama==0.4.6 huggingface_hub==2.2.0 manga-ocr==0.1.16 \
       transformers==5.20.2 natsort==8.4.0 docopt-ng==0.9.0 ConfigUpdater==4.0 \
       prettytable==3.18.0 xdg==6.0.0 tifffile==2026.3.3 dictdiffer==0.10.0 \
       humanfriendly==10.0 pytesseract==0.3.13 psd-tools==1.25.0 \
    && /opt/panelcleaner/venv/bin/pip install --no-cache-dir --no-deps simple-lama-inpainting==0.1.2
RUN mkdir -p /opt/panelcleaner/src /opt/panelcleaner/cache/model \
    && curl -fsSL "https://github.com/VoxelCubes/PanelCleaner/archive/${PCLEANER_COMMIT}.tar.gz" \
       | tar -xz -C /tmp \
    && mv "/tmp/PanelCleaner-${PCLEANER_COMMIT}/pcleaner" /opt/panelcleaner/src/ \
    && mv "/tmp/PanelCleaner-${PCLEANER_COMMIT}/LICENSE" /opt/panelcleaner/ \
    && rm -rf "/tmp/PanelCleaner-${PCLEANER_COMMIT}" \
    && echo /opt/panelcleaner/src > "$(/opt/panelcleaner/venv/bin/python -c 'import site;print(site.getsitepackages()[0])')/pcleaner-src.pth" \
    && cd /opt/panelcleaner/cache/model \
    && curl -fsSL -o comictextdetector.pt.onnx \
       https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/comictextdetector.pt.onnx \
    && curl -fsSL -o anime-manga-big-lama.pt \
       https://github.com/Sanster/models/releases/download/AnimeMangaInpainting/anime-manga-big-lama.pt \
    && printf '%s  %s\n' \
       1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f comictextdetector.pt.onnx \
       479d3afdcb7ed2fd944ed4ebcc39ca45b33491f0f2e43eb1000bd623cfb41823 anime-manga-big-lama.pt \
       | sha256sum -c - \
    && find /opt/panelcleaner -name __pycache__ -prune -exec rm -rf {} +
COPY docker/backend/pcleanerrc /opt/panelcleaner/config/pcleaner/pcleanerrc

FROM docker.io/library/node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates chromium curl ffmpeg fonts-dejavu-core fonts-noto-color-emoji \
    python3 python3-venv openssh-client rsync util-linux tesseract-ocr tesseract-ocr-eng \
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
COPY --from=panelcleaner /opt/panelcleaner /opt/panelcleaner
COPY package.json package-lock.json tsconfig.json ./
COPY src/ ./src/
COPY remotion-studio/ ./remotion-studio/
COPY tools/ ./tools/
COPY cloud-kit/ ./cloud-kit/
# Fail the build early if the bundled cleaner cannot start.
RUN /opt/panelcleaner/venv/bin/python -c "import torch, cv2, pytesseract, simple_lama_inpainting, pcleaner.main; from pcleaner.comic_text_detector.inference import TextDetector" \
    && tesseract --list-langs | grep -qx eng
RUN rm -rf src/player/public \
    && mkdir -p /data/series /data/out/jobs /data/out/config /data/thumbnails /data/auth /app/remotion-studio/public \
    && chown -R node:node /data /app/remotion-studio /opt/panelcleaner/config
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

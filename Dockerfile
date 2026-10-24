# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS javascript
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig*.json config.ts server.ts ./
COPY types ./types
COPY scripts ./scripts
COPY public ./public
COPY transcription-matrix.example.json ./
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM python:3.12-slim-bookworm AS runtime
ARG INSTALL_LOCAL_WHISPER=false
ARG INSTALL_LOCAL_AUDIO=false
ENV NODE_ENV=production \
    HOST=0.0.0.0 PORT=3000 DATA_DIR=/data \
    PYTHON_BIN=/opt/audio/bin/python YTDLP_BIN=/opt/audio/bin/yt-dlp \
    PATH=/app/node_modules/.bin:/opt/audio/bin:$PATH \
    CODEX_HOME=/data/data/private/codex \
    TRANSCRIBE_BACKEND=elevenlabs KEEP_INTERMEDIATES=false \
    SCANNER_ENABLED=false PAUSE_ON_FAILURE=true MAX_QUEUED_JOBS=20 \
    LOCAL_WHISPER_DEVICE=cpu LOCAL_WHISPER_COMPUTE_TYPE=int8 \
    LOCAL_WHISPER_ENABLED=${INSTALL_LOCAL_WHISPER} \
    LOCAL_AUDIO_ENABLED=${INSTALL_LOCAL_AUDIO} \
    OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    XDG_CACHE_HOME=/data/cache TORCH_HOME=/data/cache/torch HF_HOME=/data/cache/huggingface
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg tini util-linux ca-certificates libstdc++6 libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 studio && useradd --uid 10001 --gid studio --create-home studio \
    && mkdir -p /data/data/private/codex \
    && chmod 700 /data/data/private /data/data/private/codex \
    && chown -R studio:studio /data
WORKDIR /app
COPY requirements*.txt ./
RUN python -m venv /opt/audio \
    && /opt/audio/bin/pip install --no-cache-dir --only-binary=:all: -r requirements-download.txt \
    && if [ "$INSTALL_LOCAL_AUDIO" = "true" ] || [ "$INSTALL_LOCAL_WHISPER" = "true" ]; then \
      /opt/audio/bin/pip install --no-cache-dir --only-binary=:all: torch==2.14.1 --index-url https://download.pytorch.org/whl/cpu \
      && /opt/audio/bin/pip install --no-cache-dir --only-binary=:all: -r requirements.txt; fi \
    && if [ "$INSTALL_LOCAL_WHISPER" = "true" ]; then /opt/audio/bin/pip install --no-cache-dir --only-binary=:all: -r requirements-whisper.txt; fi
COPY --from=javascript /usr/local/bin/node /usr/local/bin/node
COPY --from=javascript /app/package.json ./package.json
COPY --from=javascript /app/node_modules ./node_modules
COPY --from=javascript /app/build ./build
COPY --chmod=755 scripts/container-entrypoint.sh /usr/local/bin/yesilcam-entrypoint
USER 10001:10001
RUN node node_modules/@openai/codex/bin/codex.js --version \
    && /opt/audio/bin/yt-dlp --version
VOLUME ["/data"]
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/yesilcam-entrypoint"]
CMD ["node", "build/server.js"]

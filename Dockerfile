FROM node:22-bookworm-slim
# System Chromium (deterministic path, no Chrome download) + Noto fallbacks for scripts Heebo/Alef do not cover.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-noto-core ca-certificates curl fontconfig \
    && rm -rf /var/lib/apt/lists/*
# Bundled fonts (SIL OFL 1.1, see fonts/OFL-*.txt and NOTICE): Heebo (variable, 100-900) + Alef Regular/Bold,
# fetched from the google/fonts repository at build time. No font is loaded from the network at runtime.
ARG FONTS_BASE=https://github.com/google/fonts/raw/main/ofl
RUN mkdir -p /usr/share/fonts/truetype/cover-forge && cd /usr/share/fonts/truetype/cover-forge \
    && curl -fsSL -o 'Heebo[wght].ttf' "$FONTS_BASE/heebo/Heebo%5Bwght%5D.ttf" \
    && curl -fsSL -o Alef-Regular.ttf "$FONTS_BASE/alef/Alef-Regular.ttf" \
    && curl -fsSL -o Alef-Bold.ttf "$FONTS_BASE/alef/Alef-Bold.ttf" \
    && fc-cache -f && fc-list | grep -qi heebo && fc-list | grep -qi alef
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    HOME=/tmp \
    DATA_DIR=/data
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY bin ./bin
COPY test ./test
RUN mkdir -p /data && chmod 777 /data
# Runs as whatever uid docker-compose sets (`user:`), default node (1000). /data is the cache + ledger volume.
USER node
EXPOSE 8793
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8793)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

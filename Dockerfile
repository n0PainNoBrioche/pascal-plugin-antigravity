# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git tini \
  && rm -rf /var/lib/apt/lists/*

# Install Pascal CLI (provides `pascal mcp connect` and `pascal mcp status`)
RUN npm install -g @pascal-app/cli

# Install Google Antigravity CLI (`agy`)
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash \
  && if [ -x /root/.local/bin/agy ]; then ln -sf /root/.local/bin/agy /usr/local/bin/agy; fi \
  && if [ -x /root/.local/bin/antigravity ]; then ln -sf /root/.local/bin/antigravity /usr/local/bin/antigravity; fi

COPY package.json tsconfig.json ./
COPY src ./src
COPY skills ./skills
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    ANTIGRAVITY_BRIDGE_HOST=0.0.0.0 \
    ANTIGRAVITY_BRIDGE_PORT=4319 \
    ANTIGRAVITY_BRIDGE_CORS_ORIGIN=* \
    ANTIGRAVITY_PASCAL_GEMINI_HOME=/data/gemini \
    ANTIGRAVITY_PASCAL_APP_DATA_DIR=/data/antigravity \
    PASCAL_HOME=/data/pascal \
    HOME=/root

VOLUME ["/data"]
EXPOSE 4319

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -fsS http://127.0.0.1:4319/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--experimental-strip-types", "src/bridge/cli.ts"]

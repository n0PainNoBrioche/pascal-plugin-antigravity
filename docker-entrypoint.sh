#!/usr/bin/env bash
set -euo pipefail

GEMINI_DIR="${ANTIGRAVITY_PASCAL_GEMINI_HOME:-/data/gemini}"
APP_DATA_DIR="${ANTIGRAVITY_PASCAL_APP_DATA_DIR:-/data/antigravity}"

mkdir -p "${GEMINI_DIR}/config" "${APP_DATA_DIR}" /data/pascal

# Symlink ~/.gemini and ~/.pascal into the persistent /data volume
if [ ! -L /root/.gemini ]; then
  rm -rf /root/.gemini
  ln -s "${GEMINI_DIR}" /root/.gemini
fi

if [ ! -L /root/.pascal ]; then
  rm -rf /root/.pascal
  ln -s /data/pascal /root/.pascal
fi

# Seed/sync bundled Pascal skills (architecte, pascal-3d, furniture-fit)
if [ -d /app/skills ]; then
  mkdir -p "${GEMINI_DIR}/config/skills"
  cp -rf /app/skills/* "${GEMINI_DIR}/config/skills/"
fi

# Seed default Pascal MCP config if not already present
MCP_CONFIG="${GEMINI_DIR}/config/mcp_config.json"
if [ ! -f "${MCP_CONFIG}" ]; then
  cat > "${MCP_CONFIG}" <<'JSON'
{
  "mcpServers": {
    "pascal": {
      "command": "pascal",
      "args": ["mcp", "connect"],
      "disabled": false
    }
  }
}
JSON
fi

exec "$@"

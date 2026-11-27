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

# Seed or update Pascal MCP config to use the serialized stdio wrapper
MCP_CONFIG="${GEMINI_DIR}/config/mcp_config.json"
if [ ! -f "${MCP_CONFIG}" ] || ! grep -q 'pascal-mcp-stdio.mjs' "${MCP_CONFIG}"; then
  cat > "${MCP_CONFIG}" <<'JSON'
{
  "mcpServers": {
    "pascal": {
      "command": "node",
      "args": ["/app/src/bridge/pascal-mcp-stdio.mjs"],
      "disabled": false
    }
  }
}
JSON
fi

# Pre-warm the managed Pascal MCP daemon so `pascal mcp connect` does not race during agy startup
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"entrypoint","version":"1.0"}}}\n' \
  | timeout 10 pascal mcp connect >/dev/null 2>&1 || true

exec "$@"

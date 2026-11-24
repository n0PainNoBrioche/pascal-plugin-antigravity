# @pascal-plugin/antigravity

A **Pascal Editor (Plugin API v1)** sidebar plugin and streaming bridge that connects **Google Antigravity** directly to **Pascal MCP**, letting you design, furnish, paint, inspect, and validate 3D architectural scenes through an in-editor chat window.

## Features

- **Native Pascal Sidebar Panel (`EditorHostPanel`)**: Lazy-loaded chat UI integrated into Pascal's left icon rail with zero custom scene node types (edits native Pascal nodes through MCP).
- **Live Streaming & Pascal MCP Tool Cards**: Streams responses and expands every Pascal MCP tool call (`load_scene`, `add_wall`, `add_door`, `add_window`, `paint`, `place_design`, `verify_scene`, `check_collisions`, `save_scene`, etc.) with live status, duration, parameters, and output.
- **Image & Floorplan Uploads**: Attach 2D floorplans, sketches, or reference photos (`PNG`, `JPG`, `WebP`, `GIF`, `PDF`, up to 6 files / 15 MB) via file picker, drag-and-drop, or clipboard paste (`Ctrl+V`). Uploaded files are saved in the workspace and read natively by Antigravity via `read_file`.
- **In-Panel Google OAuth Sign-In**: Authenticate the Antigravity CLI directly from the Pascal sidebar (`POST /auth/start`, `POST /auth/complete`) without opening a terminal.
- **Automatic Scene Context & Reload**: Reads the active scene ID, wall/zone counts, and selected node IDs from `@pascal-app/core` and `@pascal-app/viewer`, and refreshes the 3D scene automatically after `save_scene`.
- **Default `architecte` Skill Support**: Automatically injects the `architecte` skill workflow on the first turn (toggleable in panel settings).
- **Hybrid Deployment Modes**:
  1. **Next.js Host Adapter (`/api/plugins/antigravity/[...path]`)**: Runs directly inside a `pascalorg/editor` host checkout, or transparently proxies SSE streams to an upstream bridge via `ANTIGRAVITY_UPSTREAM_URL`.
  2. **Standalone Local Bridge (`antigravity-pascal-bridge`)**: Lightweight Node HTTP/SSE server (`127.0.0.1:4319` by default) with CORS and optional Bearer token authentication, plus a built-in standalone web UI at `/ui`.

## Quick Start (Standalone Bridge)

### Prerequisites

- **Node.js 24+** (uses native `--experimental-strip-types`)
- **Google Antigravity CLI** (`agy` or `antigravity`, auto-detected from `PATH`, `ANTIGRAVITY_BIN`, or T3 Code's managed binary)
- **Pascal CLI** (`@pascal-app/cli`) configured in `~/.gemini/config/mcp_config.json`

For the most reliable low-latency MCP handshake with Antigravity CLI, point the `pascal` entry in `~/.gemini/config/mcp_config.json` directly to `pascal-mcp.mjs --stdio`:

```json
{
  "mcpServers": {
    "pascal": {
      "command": "/path/to/node",
      "args": [
        "/path/to/node_modules/@pascal-app/cli/dist/services/pascal-mcp.mjs",
        "--stdio"
      ],
      "disabled": false
    }
  }
}
```

### Install, Test, and Run

```bash
npm install
npm run type-check
npm test

# Start the standalone bridge (defaults to http://127.0.0.1:4319)
npm run bridge
```

Once running:
- Health check: `GET http://127.0.0.1:4319/health`
- Standalone chat UI: `http://127.0.0.1:4319/ui`

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `ANTIGRAVITY_BIN` | auto-detected | Path to the `agy` / `antigravity` CLI binary |
| `ANTIGRAVITY_CWD` | `process.cwd()` | Working directory passed to Antigravity (also stores `.pascal-chat-uploads/`) |
| `ANTIGRAVITY_PASCAL_APP_DATA_DIR` | *(optional)* | Custom `ANTIGRAVITY_APP_DATA_DIR` profile path |
| `ANTIGRAVITY_PASCAL_GEMINI_HOME` | `~/.gemini` | Directory containing `config/mcp_config.json` and `config/skills/` |
| `ANTIGRAVITY_BRIDGE_HOST` | `127.0.0.1` | Bind address for the standalone bridge |
| `ANTIGRAVITY_BRIDGE_PORT` | `4319` | Listening port for the standalone bridge |
| `ANTIGRAVITY_BRIDGE_CORS_ORIGIN` | `*` | Allowed CORS origin(s), comma-separated |
| `ANTIGRAVITY_PASCAL_BRIDGE_TOKEN` | *(empty)* | Optional Bearer token required on all API endpoints |
| `ANTIGRAVITY_UPSTREAM_URL` | *(empty)* | When set on a Pascal host, proxies `/api/plugins/antigravity/*` (including SSE) to a remote bridge |
| `ANTIGRAVITY_UPSTREAM_TOKEN` | *(empty)* | Bearer token sent to `ANTIGRAVITY_UPSTREAM_URL` |

## Docker Deployment

A `Dockerfile` and sample `docker-compose.yml` are included for running the bridge as a sidecar container alongside a self-hosted Pascal Editor instance.

> **CPU requirement**: The Linux x64 `agy` binary requires the `pclmul` CPU instruction (`pclmulqdq`). On virtualized hosts (such as Proxmox/KVM), set the VM CPU type to `host`, or run the bridge on a `host`-CPU machine and point your Pascal container to it via `ANTIGRAVITY_UPSTREAM_URL`.

## Pascal Host Integration

See [HOST_INTEGRATION.md](./HOST_INTEGRATION.md) for step-by-step instructions to bundle `@pascal-plugin/antigravity` into a `pascalorg/editor` host checkout.

## Pascal Plugin API v1 Disclosure

- **Publisher & Repository**: [n0PainNoBrioche/pascal-plugin-antigravity](https://github.com/n0PainNoBrioche/pascal-plugin-antigravity)
- **Plugin ID**: `antigravity:chat` (`apiVersion: 1`, panel ID `antigravity:chat:panel`)
- **Capabilities**: Sidebar editor panel only; defines no custom scene nodes (all edits operate on native Pascal nodes via MCP).
- **External Origins**: Calls only same-origin `/api/plugins/antigravity/*` by default, or an explicitly user-configured bridge URL. No network calls are made when loading plugin metadata.
- **Persisted Data**: UI preferences (`mode`, `bridgeUrl`, `model`, `effort`, toggles) are stored in browser `localStorage` under `pascal-plugin-antigravity:settings:v1`. Antigravity OAuth credentials remain managed strictly by the local Antigravity CLI and are never exposed to browser JavaScript.

## License

[MIT](./LICENSE)

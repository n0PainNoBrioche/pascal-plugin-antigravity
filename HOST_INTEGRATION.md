# Integrating into a Pascal Host (`pascalorg/editor`)

Per Pascal Plugin API v1, plugins are bundled by the host application (`pascalorg/editor`) rather than downloaded dynamically at runtime.

## 1. Add the dependency in `apps/editor/package.json`

Pin a release commit from GitHub (or reference a local workspace package during development):

```json
{
  "dependencies": {
    "@pascal-plugin/antigravity": "github:n0PainNoBrioche/pascal-plugin-antigravity#<commit-sha>"
  }
}
```

## 2. Register the plugin and panel in `apps/editor/lib/bootstrap.ts`

```ts
import { antigravityHostPanel, antigravityPlugin } from '@pascal-plugin/antigravity'

extendPluginDiscovery(async () => [antigravityPlugin])
registerEditorHostPanel(antigravityHostPanel)
```

## 3. Transpile and scan Tailwind classes

Add `'@pascal-plugin/antigravity'` to `transpilePackages` in `apps/editor/next.config.ts`.

Add the Tailwind `@source` directive in `apps/editor/app/globals.css`:

```css
@source "../../../node_modules/@pascal-plugin/antigravity/src";
```

## 4. Mount the server route

Create `apps/editor/app/api/plugins/antigravity/[...path]/route.ts`:

```ts
import { handleAntigravityPascalRequest } from '@pascal-plugin/antigravity/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const route = (request: Request) => handleAntigravityPascalRequest(request)

export { route as GET, route as POST, route as OPTIONS }
```

## 5. Run locally or with a remote bridge

- **Local host**: Start Pascal with `bun dev`, open a project, and click the **Antigravity** icon in the left sidebar.
- **Docker / self-hosted Pascal**: Set `ANTIGRAVITY_UPSTREAM_URL=http://<bridge-host>:4319` (and optionally `ANTIGRAVITY_UPSTREAM_TOKEN=<secret>`) on the Pascal container so `/api/plugins/antigravity/*` proxies all requests and SSE streams to your bridge without CORS issues.

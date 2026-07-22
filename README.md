# featuretoggle-sdk-typescript

TypeScript SDK for reading features from the FeatureToggle public API — browser client and Node server entry. Plain JavaScript works.

[![Publish to npm](https://github.com/feature-toggle/sdk-typescript/actions/workflows/publish.yml/badge.svg)](https://github.com/feature-toggle/sdk-typescript/actions/workflows/publish.yml)

## Install

```bash
npm install featuretoggle-sdk-typescript
# or
pnpm add featuretoggle-sdk-typescript
# or
yarn add featuretoggle-sdk-typescript
# or
bun add featuretoggle-sdk-typescript
```

Both entries ship ESM, CJS, and types:

| Entry | Use for |
|-------|---------|
| `featuretoggle-sdk-typescript` | Browser — SSE, `subscribe()`, `close()` |
| `featuretoggle-sdk-typescript/server` | Node — `init()` + `refresh()` only |

```javascript
// ESM
import { FeatureToggle } from "featuretoggle-sdk-typescript";
import { FeatureToggleServer } from "featuretoggle-sdk-typescript/server";

// CJS
const { FeatureToggle } = require("featuretoggle-sdk-typescript");
const { FeatureToggleServer } = require("featuretoggle-sdk-typescript/server");
```

React UI: [`featuretoggle-sdk-react`](https://www.npmjs.com/package/featuretoggle-sdk-react).

## Quick start

```typescript
import { FeatureToggle } from "featuretoggle-sdk-typescript";

const ft = new FeatureToggle({
  apiKey: import.meta.env.VITE_FT_API_KEY!,
});

await ft.init();

if (ft.isEnabled("new-checkout")) {
  // ...
}

const theme = ft.getValue<string>("theme-variant");
ft.subscribe(() => {
  /* cache updated */
});
ft.close();
```

Server entry:

```typescript
import { FeatureToggleServer } from "featuretoggle-sdk-typescript/server";

const ft = new FeatureToggleServer({
  apiKey: process.env.FT_API_KEY!,
});

await ft.init();
await ft.refresh();

if (ft.isEnabled("new-checkout")) {
  // ...
}
```

## Cookbook

Full recipes in [INTEGRATION.md](./INTEGRATION.md) (Cookbook):

| Pattern | See |
|---------|-----|
| SPA singleton | [INTEGRATION.md](./INTEGRATION.md#spa-singleton-imperative) |
| Subscribe without a framework | [INTEGRATION.md](./INTEGRATION.md#subscribe-without-a-framework) |
| Seeded cache (SSR handoff) | [INTEGRATION.md](./INTEGRATION.md#seeded-cache-ssr-handoff-to-client) |
| Manual lifecycle | [INTEGRATION.md](./INTEGRATION.md#manual-lifecycle) |
| Module singleton | [INTEGRATION.md](./INTEGRATION.md#module-singleton-default) |
| Per-request server instance | [INTEGRATION.md](./INTEGRATION.md#per-request-server-instance) |
| API route / middleware gate | [INTEGRATION.md](./INTEGRATION.md#api-route--middleware-gate) |
| TTL refresh | [INTEGRATION.md](./INTEGRATION.md#ttl-refresh-singleton-variant) |
| SSR split | [INTEGRATION.md](./INTEGRATION.md#ssr-split-server-loader--client-ui) |

React patterns: [React cookbook](https://github.com/feature-toggle/sdk-react/blob/main/INTEGRATION.md).

## API

### `FeatureToggle`

Options: `apiKey` (or `FT_API_KEY`), `stream` (default `"auto"`), `pollInterval` (default `30` when `stream: "off"`; `0` disables; or `FT_POLL_INTERVAL`), `initialFeatures` / `initialEtag`, `fetch`.

| Method | Description |
|--------|-------------|
| `init()` | Fetch features and open SSE stream |
| `refresh()` | Refetch features now |
| `isEnabled(key)` | `true` when the feature is enabled in cache |
| `getValue<T>(key)` | Resolved value or `undefined` |
| `getFeatures(options?)` | Filtered copy of cached features |
| `subscribe(listener)` | Callback when cache updates; returns unsubscribe |
| `close()` | Close stream and stop transport |

`stream` / `pollInterval` semantics: [Caching and syncs](https://featuretoggle.com/docs/caching). Shared env vars: [SDKs](https://featuretoggle.com/docs/sdks).

### `FeatureToggleServer`

Same read methods plus `init()` and `refresh()`. No `close()` or background transport. Options: `apiKey`, optional `fetch`.

### `FeatureResponse`

`key`, `type`, `value`, `enabled`, `deprecated`, optional `inFavorOf`. HTTP contract: [Feature API](https://featuretoggle.com/docs/feature-api).

Enabled deprecated features are included in the bulk fetch. The SDK logs a one-time `console.warn` per key on `isEnabled()` / `getValue()`. On **401**, cache clears and transport stops. On **403**, one-time `console.warn` per instance with the API message.

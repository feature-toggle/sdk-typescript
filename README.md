# featuretoggle-sdk-typescript

TypeScript SDK for reading features from the FeatureToggle public API.

[![Publish to npm](https://github.com/feature-toggle/sdk-typescript/actions/workflows/publish.yml/badge.svg)](https://github.com/feature-toggle/sdk-typescript/actions/workflows/publish.yml)

## Install

```bash
bun add featuretoggle-sdk-typescript
# or
npm install featuretoggle-sdk-typescript
```

## Environment variables

| Variable | Required | Default | Applies to |
|----------|----------|---------|------------|
| `FT_API_KEY` | yes | — | Client + server (usually passed to the constructor instead) |

## Client (browser / SPA)

Use a **non-production** environment key (`ft_test_`) in the browser — see [Security](#security). Never embed production keys (`ft_live_`) in client bundles.

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
const features = ft.getFeatures({ type: "boolean" });

ft.close();
```

The client loads features on `init()`, opens an **SSE stream** for `features-changed` events (default **auto-refresh**), and refetches when you return to the tab. No background poll timer.

```typescript
ft.subscribe(() => {
  // optional — run after cache updates (stream notify mode or refresh)
});
```

## Integration patterns

See [INTEGRATION.md](./INTEGRATION.md) for server loaders, SSR seed, API route gates, subscribe without React, framework notes, and security details.

## Server (Node.js / SSR)

```typescript
import { FeatureToggleServer } from "featuretoggle-sdk-typescript/server";

const ft = new FeatureToggleServer({
  apiKey: process.env.FT_API_KEY!,
});

await ft.init();

if (ft.isEnabled("new-checkout")) {
  // ...
}

await ft.refresh();
```

No background polling — fetch on `init()` and `refresh()` only. Create one instance per process (module singleton). **Await `refresh()`** before reads when handling concurrent requests from one instance.

## API reference

### `FeatureToggle`

| Method | Description |
|--------|-------------|
| `init()` | Fetch features and open SSE stream |
| `refresh()` | Refetch features now |
| `isEnabled(key)` | `true` when the feature is enabled in cache |
| `getValue<T>(key)` | Resolved value or `undefined` |
| `getFeatures(options?)` | Filtered copy of cached features |
| `subscribe(listener)` | Callback when cache updates; returns unsubscribe fn |
| `close()` | Close stream and stop transport |

### `FeatureToggleServer`

Same read methods as the client, plus `init()` and `refresh()`. No `close()` or background transport.

### `FeatureResponse`

Public type mirroring the API response shape: `key`, `type`, `value`, `enabled`, `deprecated`, optional `inFavorOf`.

## Deprecated features

Enabled deprecated features are included in the default bulk fetch. The SDK logs a one-time `console.warn` per feature key when accessed via `isEnabled()` or `getValue()`.

## API keys

Create an API key in the [FeatureToggle dashboard](https://app.featuretoggle.com) for your project environment.

## Security

The SDK is **read-only** — it cannot create, update, or delete features. Feature management is done in the dashboard.

**API keys in the browser are public.** Any key in a client bundle (`VITE_*`, inlined env) can be extracted. Use **test keys** (`ft_test_`) with `featuretoggle-sdk-typescript` in the browser — they only work from **localhost** (`http://localhost`, `127.0.0.1`, `::1`). Deployed apps and server-side fetches need **live keys** (`ft_live_`) from a paid plan, via `featuretoggle-sdk-typescript/server` on trusted backends.

On **403** scope errors, the SDK logs a **one-time** `console.warn` per instance with the API error message.

**Read-only, not secret.** A key grants read access to all enabled features for one environment. The public API accepts cross-origin requests with a valid Bearer token. Revoke compromised keys in the dashboard; the SDK clears its cache on `401`.

**Features are not authorization.** Client-side `isEnabled()` is for UX only — use `featuretoggle-sdk-typescript/server` on your backend for access control and sensitive routing.

**Sanitize feature values.** Treat JSON from `getValue()` as untrusted before rendering in HTML or executing as code.

**Custom `fetch`.** The optional `fetch` constructor option is for unit tests. Do not log request headers in production wrappers.

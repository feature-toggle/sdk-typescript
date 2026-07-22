# TypeScript cookbook

Recipes for `featuretoggle-sdk-typescript` and `featuretoggle-sdk-typescript/server`. Using React? See [`featuretoggle-sdk-react`](https://www.npmjs.com/package/featuretoggle-sdk-react) and its [Cookbook](https://github.com/feature-toggle/sdk-react/blob/main/INTEGRATION.md).

Install and API surface: [README](./README.md). Platform rules (keys, authz, sanitization): [Security](https://featuretoggle.com/docs/security). Transport and refresh cost: [Caching and syncs](https://featuretoggle.com/docs/caching).

## Which entry

| Your runtime | Import |
|--------------|--------|
| Browser SPA (no framework) | `featuretoggle-sdk-typescript` |
| Node server / SSR loader / API route | `featuretoggle-sdk-typescript/server` |
| React UI | [`featuretoggle-sdk-react`](https://www.npmjs.com/package/featuretoggle-sdk-react) (peers this package) |
| SSR + hydrated React | Server entry in loader **and** React adapter in client tree |

---

## Client patterns (browser)

### SPA singleton (imperative)

One instance at app bootstrap; call methods anywhere. Use a non-production key in the browser ([Security](https://featuretoggle.com/docs/security)).

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

### Subscribe without a framework

```typescript
const ft = new FeatureToggle({ apiKey });
await ft.init();

ft.subscribe(() => {
  renderUI(ft.isEnabled("new-checkout"));
});
```

### Seeded cache (SSR handoff to client)

Pre-populate when the server already fetched features. Pairs with [SSR split](#ssr-split-server-loader--client-ui). Do not seed flags that must stay server-only ([Security](https://featuretoggle.com/docs/security)).

```typescript
const ft = new FeatureToggle({
  apiKey,
  initialFeatures: loaderFeatures,
  initialEtag: loaderEtag,
});

await ft.init(); // opens stream; may 304 on first fetch
```

### Manual lifecycle

```typescript
const ft = new FeatureToggle({ apiKey, stream: "off" });
// ... later
await ft.init();
// ... on unload
ft.close();
```

`stream` values and poll behavior: [Caching and syncs](https://featuretoggle.com/docs/caching).

---

## Server patterns (Node)

### Module singleton (default)

One instance per process. **Await `refresh()`** before reads under concurrent requests, or use a [per-request instance](#per-request-server-instance).

```typescript
import { FeatureToggleServer } from "featuretoggle-sdk-typescript/server";

let ft: FeatureToggleServer | null = null;

export async function getServerFt() {
  if (!ft) {
    ft = new FeatureToggleServer({ apiKey: process.env.FT_API_KEY! });
    await ft.init();
  }
  return ft;
}

const ft = await getServerFt();
await ft.refresh();
if (ft.isEnabled("beta")) {
  /* branch */
}
```

### Per-request server instance

One bulk fetch per request. Strict isolation; higher origin load.

```typescript
export async function handleRequest() {
  const ft = new FeatureToggleServer({ apiKey: process.env.FT_API_KEY! });
  await ft.init();
  return ft.isEnabled("feature-x");
}
```

### API route / middleware gate

Gate redirects, JSON responses, and authorization on the server. Client `isEnabled()` is not authorization ([Security](https://featuretoggle.com/docs/security)).

```typescript
const ft = await getServerFt();
await ft.refresh();
if (!ft.isEnabled("api-v2")) {
  return new Response("Not found", { status: 404 });
}
```

### TTL refresh (singleton variant)

Refresh only when cache age exceeds your TTL.

```typescript
let lastRefreshAt = 0;
const TTL_MS = 30_000;

const ft = await getServerFt();
if (Date.now() - lastRefreshAt > TTL_MS) {
  await ft.refresh();
  lastRefreshAt = Date.now();
}
```

---

## SSR split (server loader + client UI)

Full-stack apps combine **server core** and a **client adapter** — there is no server provider package.

| Step | Entry | Role |
|------|-------|------|
| Loader / middleware | `featuretoggle-sdk-typescript/server` | Redirects, SSR branches, seed data |
| Client layout | `featuretoggle-sdk-typescript` or `featuretoggle-sdk-react` | Live updates in the browser |
| Optional seed | `initialFeatures` on client or React provider | Match SSR without loading flash |

```
Route loader          FeatureToggleServer
      │                      │
      ├──── refresh() ───────┤
      │                      │
      ▼                      ▼
  SSR HTML / loader data ──► FeatureToggle or FeatureToggleProvider
```

Server reads stay imperative in loaders and route handlers. The client handles hydration and subscriptions.

For React apps, use [`featuretoggle-sdk-react`](https://www.npmjs.com/package/featuretoggle-sdk-react) on the client — see its [SSR seed pattern](https://github.com/feature-toggle/sdk-react/blob/main/INTEGRATION.md#ssr-seed-no-flash).

---

## React adapter

Prefer [`featuretoggle-sdk-react`](https://www.npmjs.com/package/featuretoggle-sdk-react) for `FeatureToggleProvider`, `useFeature`, and `useFeatureToggle`. Recipes: [React cookbook](https://github.com/feature-toggle/sdk-react/blob/main/INTEGRATION.md).

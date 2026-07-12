# TypeScript integration patterns

Recipes for `featuretoggle-sdk-typescript` and `featuretoggle-sdk-typescript/server`. Using React? See [`featuretoggle-sdk-react`](https://www.npmjs.com/package/featuretoggle-sdk-react) and its [integration guide](https://github.com/feature-toggle/sdk-react/blob/main/INTEGRATION.md).

No single golden path — pick what fits your runtime, framework, and freshness needs.

## Package picker

| Your runtime | Import |
|--------------|--------|
| Browser SPA (no framework) | `featuretoggle-sdk-typescript` |
| Node server / SSR loader / API route | `featuretoggle-sdk-typescript/server` |
| React UI | [`featuretoggle-sdk-react`](https://www.npmjs.com/package/featuretoggle-sdk-react) (peers this package) |
| SSR + hydrated React | Server entry in loader **and** React adapter in client tree |

Both entries ship **ESM + CJS + types**. Plain JavaScript works — TypeScript is optional.

```javascript
// ESM
import { FeatureToggle } from "featuretoggle-sdk-typescript";
import { FeatureToggleServer } from "featuretoggle-sdk-typescript/server";

// CJS
const { FeatureToggle } = require("featuretoggle-sdk-typescript");
const { FeatureToggleServer } = require("featuretoggle-sdk-typescript/server");
```

### Package exports

| Entry | Use for |
|-------|---------|
| `featuretoggle-sdk-typescript` | Browser client — SSE stream, `subscribe()`, `close()` |
| `featuretoggle-sdk-typescript/server` | Node — `init()` + `refresh()` only, no background transport |

---

## Security

### API keys in the browser are public

Keys in client bundles (`VITE_*`, inlined env) can be extracted. Use **test keys** (`ft_test_`) from `development` on **localhost** with the client entry. Use **live keys** (`ft_live_`) from `staging` / `production` for deployed apps and `featuretoggle-sdk-typescript/server` on trusted backends.

### Read-only, not secret

Keys grant read access to all enabled flags for one environment. Revoke compromised keys in the dashboard; the SDK clears its cache on `401`.

### Feature flags are not authorization

Client `isEnabled()` is for UX only — use server patterns ([API route / middleware gate](#api-route--middleware-gate)) for access control and sensitive routing.

### Sanitize flag values

Treat `getValue()` JSON as untrusted before HTML rendering or code execution.

### SSR seed exposure

Patterns that pass `initialFeatures` embed flag state in HTML or loader data visible to the client — do not seed flags that must stay server-only.

### SSR localhost and test keys

Server `fetch` without `Origin` returns **403** for test keys. Use a custom `fetch` with `Origin: http://localhost:<port>`, client-only init, or `ft_live_` in a deployed environment.

### Server singleton concurrency

When sharing one `FeatureToggleServer` per process, **await `refresh()`** before reads under concurrent requests, or use a [per-request server instance](#per-request-server-instance).

### Custom fetch

The optional `fetch` constructor option is for unit tests. Do not log `Authorization` headers in production wrappers.

---

## Client patterns (browser)

`FeatureToggle` — loads on `init()`, opens an SSE stream for live updates, refetches on tab focus. Call `close()` on teardown.

### SPA singleton (imperative)

One instance at app bootstrap; call methods anywhere. Use a non-production key in the browser (see [API keys in the browser are public](#api-keys-in-the-browser-are-public)).

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

Use `subscribe()` for vanilla JS or custom framework glue.

```typescript
const ft = new FeatureToggle({ apiKey });
await ft.init();

ft.subscribe(() => {
  renderUI(ft.isEnabled("new-checkout"));
});
```

### Seeded cache (SSR handoff to client)

Pre-populate before `init()` when the server already fetched features. Pairs with [SSR split](#ssr-split-server-loader--client-ui) or a hand-rolled client bootstrap.

```typescript
const ft = new FeatureToggle({
  apiKey,
  initialFeatures: loaderFeatures,
  initialEtag: loaderEtag,
});

await ft.init(); // opens stream; may 304 on first fetch
```

Do not seed flags that must remain server-only (see [SSR seed exposure](#ssr-seed-exposure)).

### Manual lifecycle

Construct, optionally seed, call `init()` when ready, `close()` on teardown.

```typescript
const ft = new FeatureToggle({ apiKey, stream: "off" });
// ... later
await ft.init();
// ... on unload
ft.close();
```

`stream` options: `"auto"` (default — refresh on SSE events), `"notify"` (subscribe only, no auto-refresh), `"off"`.

---

## Server patterns (Node)

`FeatureToggleServer` — fetch on `init()` and `refresh()` only. No SSE, no `subscribe()`, no `close()`.

### Module singleton (default)

One instance per process; refresh when you need freshness.

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

// per request
const ft = await getServerFt();
await ft.refresh();
if (ft.isEnabled("beta")) {
  /* branch */
}
```

**Await `refresh()`** before reads when handling concurrent requests from one instance (see [Server singleton concurrency](#server-singleton-concurrency)).

### Per-request server instance

Strict isolation; one bulk fetch per request. Simplest mental model; higher origin load.

```typescript
export async function handleRequest() {
  const ft = new FeatureToggleServer({ apiKey: process.env.FT_API_KEY! });
  await ft.init();
  return ft.isEnabled("feature-x");
}
```

### API route / middleware gate

Server entry only — no React. **This is the security boundary** for sensitive flags: gate redirects, JSON responses, and authorization checks here. Client-side `isEnabled()` alone is not authorization.

```typescript
// route handler, Express middleware, TanStack Start server route, etc.
const ft = await getServerFt();
await ft.refresh();
if (!ft.isEnabled("api-v2")) {
  return new Response("Not found", { status: 404 });
}
```

### TTL refresh (singleton variant)

Call `refresh()` only when cache age exceeds your TTL (track `lastRefreshAt` in app code). Fewer origin calls; slightly staler reads.

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
| Optional seed | `initialFeatures` on client constructor or React provider | Match SSR without loading flash |

```
Route loader          FeatureToggleServer
      │                      │
      ├──── refresh() ───────┤
      │                      │
      ▼                      ▼
  SSR HTML / loader data ──► FeatureToggle or FeatureToggleProvider
```

Server reads stay imperative in loaders and route handlers. The client handles hydration and subscriptions.

For React apps, use [`featuretoggle-sdk-react`](https://www.npmjs.com/package/featuretoggle-sdk-react) on the client side — see its [SSR seed pattern](https://github.com/feature-toggle/sdk-react/blob/main/INTEGRATION.md#ssr-seed-no-flash).

---

## Framework notes

These are recipes, not shipped packages:

| Framework | Approach |
|-----------|----------|
| TanStack Router / Start | Server loader uses `FeatureToggleServer`; client uses core client or React adapter |
| Next.js App Router | Server Component or loader uses `/server`; client boundary uses `FeatureToggle` or `featuretoggle-sdk-react` |
| TanStack Query | Key `['features']`; `queryFn` wraps `ft.getFeatures()`; invalidate on `ft.subscribe()` |
| Redux / Zustand | `subscribe()` dispatches a slice update |
| Edge runtime | `FeatureToggleServer` with custom `fetch` if Node APIs unavailable — test in your deploy target |

---

## Freshness vs cost

| Pattern | Freshness | Origin load |
|---------|-----------|-------------|
| Client stream (default) | Good for open tabs | Low when ETag / 304 works |
| SSR seed + client stream | Good SSR + live client | Medium |
| Server per-request refresh | Best per page load | Highest |
| Server singleton + refresh per request | Good | Medium |
| Server singleton + TTL refresh | Configurable | Lower |

---

## React adapter

If you use React, prefer [`featuretoggle-sdk-react`](https://www.npmjs.com/package/featuretoggle-sdk-react) — `FeatureToggleProvider`, `useFeature`, and `useFeatureToggle` wrap this package with `useSyncExternalStore`. Peer dependency: `featuretoggle-sdk-typescript` ^1.0.2.

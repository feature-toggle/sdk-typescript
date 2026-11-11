# AGENTS.md — featuretoggle-sdk-typescript

The core SDK for the FeatureToggle read-only Feature API. This repo is **public**, so only reference things in it or public URLs (`https://featuretoggle.com/docs/*`).

## Layout

- `src/index.ts` is `FeatureToggle`, the browser client: SSE stream, `subscribe()`, poll fallback, focus refetch.
- `src/server.ts` is `FeatureToggleServer`: only `init()` and `refresh()`, with no background transport.
- `src/shared/` holds the internals (fetch, cache, SSE parse, poll scheduling). It is never exported.
- `test/` uses `bun test` with mocked `fetch`, plus the golden fixture `test/fixtures/features-bulk-200.json`.

## Rules

- **Public surface stays minimal:** the two classes, their options types, and `FeatureResponse`. Adding an export is a semver-minor change.
- **The base URL is hardcoded** (`API_BASE_URL`). There is no `baseUrl` option.
- **The bulk fetch never sends filter params.** `getFeatures()` filters on the client and returns a copy. Stream-triggered refetches add only `_v=<featuresVersion>` (an edge cache-buster) and omit `If-None-Match`.
- **Seconds everywhere:** `pollInterval`, `FT_POLL_INTERVAL`, and `X-FeatureToggle-Poll-Interval-Sec`.
- **On `401`:** clear the cache, stop all transport, and notify listeners.
- **On `403`:** warn once.
- **Deprecated keys:** warn once per key per instance.
- **Don't change behaviour silently.** Update `README.md` (API) and `INTEGRATION.md` (Cookbook) in the same change.
- **Browser guidance:** keys are read-only and work in the browser; say that `isEnabled()` is not authorization.

## Verify and release

- Run `bun run verify` (format, lint, types, test).
- Publishing happens when a version tag is pushed, which triggers `.github/workflows/publish.yml`. Only do it when asked. Bump the version in `package.json`, and coordinate with `featuretoggle-sdk-react`'s peer range.
- Biome: `biome.standalone.json` is used standalone. `biome.json` (`extends: "//"`) only applies when this repo is checked out inside a parent Biome workspace.

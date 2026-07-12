import type { VisibilitySource } from "../src/shared/visibility.js";
import type { FeatureResponse } from "../src/shared/types.js";

export function feature(
  overrides: Partial<FeatureResponse> & Pick<FeatureResponse, "key">,
): FeatureResponse {
  return {
    type: "boolean",
    value: true,
    enabled: true,
    deprecated: false,
    ...overrides,
  };
}

export function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

export function createMockFetch(
  handler: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
): typeof fetch & { callCount: () => number } {
  let calls = 0;
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    return Promise.resolve(handler(input, init));
  }) as typeof fetch & { callCount: () => number };

  fetchFn.callCount = () => calls;
  return fetchFn;
}

/** Default mock — features JSON + inert SSE stream. */
export function createDefaultMockFetch(
  handler: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
): typeof fetch & { callCount: () => number } {
  return createMockFetch((input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/features/stream")) {
      return new Response(new ReadableStream(), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return handler(input, init);
  });
}

export type TestVisibility = VisibilitySource & {
  setHidden(next: boolean): void;
};

export function createVisibility(hidden = false): TestVisibility {
  const listeners = new Set<() => void>();
  let isHidden = hidden;

  return {
    get hidden() {
      return isHidden;
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    setHidden(next: boolean) {
      isHidden = next;
      for (const listener of listeners) listener();
    },
  };
}

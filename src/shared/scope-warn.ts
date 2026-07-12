const DEFAULT_SCOPE_MESSAGE =
  "FeatureToggle: test keys work on localhost only; live keys require a paid plan for deployed apps.";

export function createScopeWarner(): (message?: string) => void {
  let warned = false;
  return (message?: string) => {
    if (warned) return;
    warned = true;
    console.warn(message ?? DEFAULT_SCOPE_MESSAGE);
  };
}

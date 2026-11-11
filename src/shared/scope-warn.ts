const DEFAULT_SCOPE_MESSAGE =
  "FeatureToggle: the API refused this key (HTTP 403). Check the organization in the FeatureToggle dashboard.";

export function createScopeWarner(): (message?: string) => void {
  let warned = false;
  return (message?: string) => {
    if (warned) return;
    warned = true;
    console.warn(message ?? DEFAULT_SCOPE_MESSAGE);
  };
}

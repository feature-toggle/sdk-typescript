/** Parse decimal featuresVersion from an ETag header value (`"42"` or `42`). */
export function parseFeaturesVersionFromEtag(etag: string | null | undefined): number | null {
  if (!etag) return null;
  const trimmed = etag.trim().replace(/^"|"$/g, "");
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

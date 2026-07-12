export type ParsedSseEvent = {
  event: string;
  data: unknown;
};

export function parseSseChunk(buffer: string): {
  events: ParsedSseEvent[];
  remainder: string;
} {
  const events: ParsedSseEvent[] = [];
  const parts = buffer.split("\n\n");
  const remainder = parts.pop() ?? "";

  for (const part of parts) {
    if (!part.trim()) continue;

    let eventName = "message";
    const dataLines: string[] = [];

    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }

    if (dataLines.length === 0) continue;

    try {
      events.push({
        event: eventName,
        data: JSON.parse(dataLines.join("\n")),
      });
    } catch {
      // ignore malformed event payloads
    }
  }

  return { events, remainder };
}

export function readFeaturesVersionFromEventData(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const version = (data as { featuresVersion?: unknown }).featuresVersion;
  if (typeof version !== "number" || !Number.isFinite(version)) return null;
  return version;
}

export type VisibilitySource = {
  readonly hidden: boolean;
  addEventListener(
    type: "visibilitychange",
    listener: () => void,
  ): void;
  removeEventListener(
    type: "visibilitychange",
    listener: () => void,
  ): void;
};

export function getVisibilitySource(): VisibilitySource | null {
  if (typeof document === "undefined") return null;
  return document;
}

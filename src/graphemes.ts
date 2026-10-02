// Shared by editing and rendering: cursor positions remain UTF-16 offsets, but only at grapheme boundaries.
export const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function snapGraphemeBoundary(text: string, position: number, direction: "backward" | "forward" = "backward"): number {
  const cursor = Math.max(0, Math.min(Math.floor(position), text.length));
  const segment = graphemes.segment(text).containing(cursor);
  if (!segment || segment.index === cursor) return cursor;
  return direction === "forward" ? segment.index + segment.segment.length : segment.index;
}
export function previousGraphemeBoundary(text: string, position: number): number {
  const cursor = snapGraphemeBoundary(text, position);
  return graphemes.segment(text).containing(cursor - 1)?.index ?? 0;
}
export function nextGraphemeBoundary(text: string, position: number): number {
  const segment = graphemes.segment(text).containing(snapGraphemeBoundary(text, position));
  return segment ? segment.index + segment.segment.length : text.length;
}

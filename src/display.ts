import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import { graphemes, snapGraphemeBoundary } from "./graphemes.js";

export const cells = (text: string): number => stringWidth(text);
export const plain = (text: string): string => stripVTControlCharacters(text)
  .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");

export function clip(text: string, width: number, ellipsis = true): string {
  const clean = plain(text);
  if (cells(clean) <= width) return clean;
  if (width <= 0) return "";
  const suffix = ellipsis ? "…" : "";
  let result = "";
  for (const { segment } of graphemes.segment(clean)) {
    if (cells(result + segment) > width - cells(suffix)) break;
    result += segment;
  }
  return result + suffix;
}
export function pad(text: string, width: number): string {
  const value = clip(text, width);
  return value + " ".repeat(Math.max(0, width - cells(value)));
}
export function wrap(text: string, width: number, maxLines: number): string[] {
  if (width <= 0 || maxLines <= 0) return [];
  let remaining = plain(text).trim();
  const lines: string[] = [];
  while (remaining && lines.length < maxLines) {
    if (lines.length === maxLines - 1) { lines.push(clip(remaining, width)); break; }
    let chunk = clip(remaining, width, false);
    if (!chunk) break;
    const space = chunk.lastIndexOf(" ");
    if (chunk.length < remaining.length && space > chunk.length / 2) chunk = chunk.slice(0, space);
    lines.push(chunk.trimEnd());
    remaining = remaining.slice(chunk.length).trimStart();
  }
  return lines;
}

// The caret and text viewport are calculated together in terminal cells, not JS string length.
export function inputViewport(text: string, cursor: number, width: number): { text: string; caret: number } {
  const segments = Array.from(graphemes.segment(text));
  const position = snapGraphemeBoundary(text, cursor);
  const preceding = segments.filter(segment => segment.index + segment.segment.length <= position);
  let before = "";
  for (let i = preceding.length - 1; i >= 0; i--) {
    const segment = plain(preceding[i]!.segment);
    if (cells(segment + before) > width - 1) break;
    before = segment + before;
  }
  const offset = preceding.length ? preceding.at(-1)!.index + preceding.at(-1)!.segment.length : 0;
  const after = clip(text.slice(offset), Math.max(0, width - cells(before)), false);
  return { text: before + after, caret: cells(before) };
}

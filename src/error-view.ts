import { cells, clip } from "./display.js";
import { diagnosticText } from "./errors.js";
import { graphemes } from "./graphemes.js";
import type { FormModel } from "./form-model.js";

const cache = new WeakMap<FormModel, { text: string; width: number; lines: string[] }>();
export function detailLines(text: string, width: number): string[] {
  if (width < 1) return [];
  const lines: string[] = [];
  for (const paragraph of diagnosticText(text).replace(/\t/g, "    ").split("\n")) {
    let line = "", used = 0;
    for (const { segment } of graphemes.segment(paragraph)) {
      const size = cells(segment);
      if (used + size > width && line) { lines.push(line); line = ""; used = 0; }
      line += size > width ? clip(segment, width) : segment;
      used += Math.min(size, width);
    }
    lines.push(line);
  }
  return lines;
}
export function errorView(model: FormModel, width: number, height: number, color: boolean): { text: string; detailsOffset: number; tooSmall: false } {
  const content = width - 5;
  const text = model.errorDetails || model.error;
  let saved = cache.get(model);
  if (!saved || saved.text !== text || saved.width !== content) {
    saved = { text, width: content, lines: detailLines(text, content) }; cache.set(model, saved);
  }
  const page = height - 3;
  const offset = Math.max(0, Math.min(model.detailsOffset, Math.max(0, saved.lines.length - page)));
  const title = model.notice || `Error details ${offset + 1}–${Math.min(offset + page, saved.lines.length)} / ${saved.lines.length}`;
  const paint = (value: string, code: string) => color ? `\x1b[${code}m${value}\x1b[0m` : value;
  const lines = [paint(clip(title, content), "1;38;5;111"), "", ...saved.lines.slice(offset, offset + page)];
  while (lines.length < height - 1) lines.push("");
  lines.push(paint(clip("↑↓ scroll · Ctrl+Y copy · Esc back", content), "38;5;245"));
  return { text: lines.map(line => "  " + line).join("\r\n"), detailsOffset: offset, tooSmall: false };
}

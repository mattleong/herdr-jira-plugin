import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { terminalScreen } from "../src/display.js";
import { initialModel, update, renderFrame } from "../src/ui.js";

const reset = "\x1b[0m", background = "\x1b[48;2;26;27;38m";
test("solid background fills the screen before content without changing layout", () => {
  const model = initialModel(); update(model, { kind: "paste", text: "MAIL-1" });
  for (const focus of [0, 1, 2, 3] as const) for (const details of [false, true]) {
    model.focus = focus; model.expanded = focus === 2;
    model.detailsOpen = details; model.error = "Long error details\n".repeat(20);
    for (const [width, height] of [[62, 11], [44, 11], [32, 8]] as const) {
      const frame = renderFrame(model, "/repo", width, { height, color: true });
      const output = terminalScreen(frame.text, true);
      assert.ok(output.startsWith("\x1b[?25l" + reset + background + "\x1b[H\x1b[2J"));
      assert.equal(stripVTControlCharacters(output), stripVTControlCharacters(frame.text));
      assert.ok(output.endsWith(reset));
      // Every internal style reset restores the flat backdrop, not the host gradient.
      for (const suffix of output.slice(0, -reset.length).split(reset).slice(1)) assert.ok(suffix.startsWith(background));
    }
  }
});
test("focused widget backgrounds survive, then return to the flat popup color", () => {
  const accent = "\x1b[1;48;5;111;38;5;16m[ Start work → ]";
  assert.ok(terminalScreen(accent + reset + " rest", true).includes(accent + reset + background + " rest"));
});
test("NO_COLOR screen drawing leaves terminal background untouched", () => {
  const frame = renderFrame(initialModel(), "/repo", 62, { height: 11, color: false });
  const output = terminalScreen(frame.text, false);
  assert.doesNotMatch(output, /\x1b\[48[;:]/);
  assert.equal(stripVTControlCharacters(output), frame.text);
});

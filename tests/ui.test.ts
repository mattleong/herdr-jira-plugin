import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { cells, inputViewport } from "../src/display.js";
import { initialModel, update, render, renderFrame, InputDecoder, type Key } from "../src/ui.js";

test("first-pass form contains a functional Pi dropdown", () => {
  const model = initialModel();
  assert.match(render(model, "/repo", 80), /Harness +\[ Pi +▾ \]/);
  update(model, { kind: "tab" }); assert.equal(model.focus, 1);
  update(model, { kind: "enter" }); assert.equal(model.expanded, true);
  assert.match(render(model, "/repo", 80), /✓ Pi/);
  update(model, { kind: "down" }); assert.equal(model.harness, "pi");
  update(model, { kind: "up" }); assert.equal(model.harness, "pi");
  assert.equal(update(model, { kind: "escape" }), undefined);
  assert.equal(model.expanded, false);
  assert.equal(update(model, { kind: "escape" }), "cancel");
});
test("paste does not navigate the dropdown or submit", () => {
  const model = initialModel();
  assert.equal(update(model, { kind: "paste", text: "MAIL-1234\r\n" }), undefined);
  assert.equal(model.ticket, "MAIL-1234");
  update(model, { kind: "tab" });
  update(model, { kind: "paste", text: "IGNORED-2" });
  assert.equal(model.ticket, "MAIL-1234");
});
test("ticket editing resets recovery approval and supports cursor edits", () => {
  const model = initialModel(); model.recover = true;
  update(model, { kind: "text", text: "MAIL-12" }); assert.equal(model.recover, false);
  update(model, { kind: "left" }); update(model, { kind: "text", text: "3" });
  assert.equal(model.ticket, "MAIL-132");
  update(model, { kind: "backspace" }); assert.equal(model.ticket, "MAIL-12");
  update(model, { kind: "tab" }); update(model, { kind: "tab" });
  assert.equal(update(model, { kind: "enter" }), "submit");
});
test("input decoder preserves bracketed paste across every chunk split", () => {
  const text = "\x1b[200~https://jira.test/browse/MAIL-1234\r\n\x1b[201~\t\r";
  for (let split = 1; split < text.length; split++) {
    const events: Key[] = [];
    const decoder = new InputDecoder(key => events.push(key));
    decoder.feed(text.slice(0, split)); decoder.feed(text.slice(split));
    assert.deepEqual(events, [{ kind: "paste", text: "https://jira.test/browse/MAIL-1234\r\n" }, { kind: "tab" }, { kind: "enter" }]);
  }
});
test("arrow and escape sequences decode without contaminating the ticket", () => {
  const events: Key[] = [];
  const decoder = new InputDecoder(key => events.push(key));
  decoder.feed("\x1b["); decoder.feed("A\x1b[Z\x1b");
  decoder.flushEscape();
  assert.deepEqual(events, [{ kind: "up" }, { kind: "backtab" }, { kind: "escape" }]);
});
test("unknown CSI sequences are ignored even when fragmented", () => {
  const events: Key[] = [];
  const decoder = new InputDecoder(key => events.push(key));
  for (const char of "\x1b[5~\x1b[1;5A") decoder.feed(char);
  assert.deepEqual(events, []);
});
test("escape inside a fragmented paste is not interpreted as cancellation", () => {
  const events: Key[] = [];
  const decoder = new InputDecoder(key => events.push(key));
  decoder.feed("\x1b[200~");
  decoder.feed("\x1b"); decoder.flushEscape();
  decoder.feed("[201~");
  assert.deepEqual(events, [{ kind: "paste", text: "" }]);
});
test("compact layout has one external title, a short repo name and aligned fields", () => {
  const model = initialModel();
  const frame = renderFrame(model, "/Users/me/dev/herdr-jira-plugin", 70);
  const lines = frame.text.split("\r\n");
  assert.doesNotMatch(frame.text, /Start Jira ticket|\/Users\/me|Ctrl\+O|Ctrl\+C/);
  assert.match(frame.text, /Repository +herdr-jira-plugin/);
  assert.match(frame.text, /Paste a ticket ID or URL/);
  assert.equal(cells(lines[4]!), cells(lines[5]!));
  assert.equal(cells(lines[4]!), cells(lines[6]!));
  assert.equal(cells(lines[4]!), cells(lines[10]!)); // CTA right edge aligns to input.
  assert.deepEqual(frame.cursor, { row: 6, column: 5 });
  assert.match(lines[10]!, /^ +\[ Start work → \]$/);
});
test("all focus, dropdown, feedback and color states stay within the viewport", () => {
  for (const width of [8, 16, 43, 44, 64, 68, 70, 72, 120]) {
    for (const height of [0, 1, 8, 15, 16, 24]) {
      for (const focus of [0, 1, 2] as const) {
        const model = initialModel();
        model.focus = focus; model.expanded = focus === 1;
        model.ticket = "https://example.test/browse/" + "A".repeat(180);
        model.cursor = model.ticket.length;
        model.error = "A long startup error with a path /Users/me/somewhere. ".repeat(20);
        const options = { height, canOpen: true };
        const frame = renderFrame(model, "/Users/me/漢字😀e\u0301-repository-name", width, options);
        const colored = renderFrame(model, "/Users/me/漢字😀e\u0301-repository-name", width, { ...options, color: true });
        assert.equal(stripVTControlCharacters(colored.text), frame.text);
        assert.deepEqual(colored.cursor, frame.cursor);
        const lines = frame.text ? frame.text.split("\r\n") : [];
        assert.ok(lines.length <= height);
        for (const line of lines) assert.ok(cells(line) < width, `line overflow at ${width}: ${line}`);
        if (frame.cursor) {
          assert.ok(frame.cursor.row <= height && frame.cursor.row > 0);
          assert.ok(frame.cursor.column < width && frame.cursor.column > 0);
          assert.equal(focus, 0);
        }
        if (width < 44 || height < 16) { assert.equal(frame.tooSmall, true); assert.equal(frame.cursor, undefined); }
      }
    }
  }
});
test("cursor shares input viewport geometry through scrolling and resizing", () => {
  const model = initialModel();
  model.ticket = "https://example.test/browse/" + "MAIL-1234".repeat(20);
  for (const width of [44, 64, 70]) {
    for (const cursor of [0, 1, 40, model.ticket.length]) {
      model.cursor = cursor;
      const frame = renderFrame(model, "/repo", width);
      const content = Math.min(64, width - 5);
      const viewport = inputViewport(model.ticket, cursor, content - 4);
      assert.deepEqual(frame.cursor, { row: 6, column: 5 + viewport.caret });
      assert.ok(frame.text.split("\r\n")[5]!.includes(viewport.text));
      assert.doesNotMatch(frame.text, /Paste a ticket/);
    }
  }
});
test("wide and combining characters use terminal cells without splitting graphemes", () => {
  const viewport = inputViewport("A漢😀e\u0301XYZ", "A漢😀e\u0301".length, 8);
  assert.equal(viewport.caret, 6);
  assert.equal(viewport.text, "A漢😀e\u0301XY");
  const scrolled = inputViewport("A漢😀e\u0301XYZ", "A漢😀e\u0301XYZ".length, 5);
  assert.ok(cells(scrolled.text) <= 5);
  assert.equal(scrolled.caret, 4);
  assert.equal(scrolled.text, "e\u0301XYZ");
});
test("styling is applied after sanitizing values and never leaks into later output", () => {
  const model = initialModel();
  model.ticket = "MAIL-1\x1b[2J"; model.cursor = model.ticket.length;
  model.error = "Bad \x1b[31mvalue\x1b[0m\x07";
  const output = renderFrame(model, "/repo\x1b[2J", 70, { color: true }).text;
  assert.equal(output.includes("\x1b[2J"), false);
  assert.equal(output.includes("\x07"), false);
  assert.ok(output.endsWith("\x1b[0m"));
  assert.equal(render(model, "/repo\x1b[2J", 70).includes("\x1b"), false);
});
test("footer reflects actual recovery availability, dropdown state and busy state", () => {
  const model = initialModel();
  model.error = "Failed to start Pi."; model.recover = true;
  assert.doesNotMatch(renderFrame(model, "/repo", 70).text, /Ctrl\+O/);
  assert.match(renderFrame(model, "/repo", 70, { canOpen: true }).text, /Ctrl\+O open preserved workspace/);
  assert.match(renderFrame(model, "/repo", 70).text, /Resume launch →/);
  model.focus = 1; model.expanded = true;
  assert.match(renderFrame(model, "/repo", 70).text, /Enter confirm · Esc close/);
  const busy = renderFrame(model, "/repo", 70, { busy: true, status: "Fetching latest changes…", canOpen: true });
  assert.doesNotMatch(busy.text, /Esc cancel|Ctrl\+O|Enter confirm/);
  assert.match(busy.text, /Working…|Fetching latest changes/);
  assert.equal(busy.cursor, undefined);
  const smallBusy = renderFrame(model, "/repo", 32, { busy: true, height: 8 });
  assert.doesNotMatch(smallBusy.text, /Esc to cancel/);
  assert.match(smallBusy.text, /please wait/);
});

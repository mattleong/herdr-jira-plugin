import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { graphemes } from "../src/graphemes.js";
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
test("Unicode movement, insertion and deletion operate on complete graphemes", () => {
  for (const cluster of ["😀", "e\u0301", "👩‍💻", "🇺🇸", "👍🏽"]) {
    const model = initialModel(), prefix = "MAIL-1";
    update(model, { kind: "paste", text: prefix + cluster });
    update(model, { kind: "left" });
    assert.equal(model.cursor, prefix.length);
    assert.deepEqual(renderFrame(model, "/repo", 70).cursor, { row: 4, column: 5 + cells(prefix) });
    update(model, { kind: "text", text: "X" });
    assert.equal(model.ticket, prefix + "X" + cluster);
    update(model, { kind: "right" });
    assert.equal(model.cursor, model.ticket.length);
    update(model, { kind: "backspace" });
    assert.equal(model.ticket, prefix + "X");
    update(model, { kind: "paste", text: cluster + "Z" });
    update(model, { kind: "left" }); update(model, { kind: "left" });
    update(model, { kind: "delete" });
    assert.equal(model.ticket, prefix + "XZ");
    assert.equal(model.cursor, prefix.length + 1);
    assert.equal(Buffer.from(model.ticket).toString(), model.ticket);
  }
});
test("edits that merge graphemes keep the caret at a rendered boundary", () => {
  const model = initialModel();
  const boundary = () => {
    const positions = [0, ...Array.from(graphemes.segment(model.ticket), item => item.index + item.segment.length)];
    assert.ok(positions.includes(model.cursor));
    for (const width of [44, 70]) {
      const viewport = inputViewport(model.ticket, model.cursor, Math.min(64, width - 5) - 4);
      assert.equal(renderFrame(model, "/repo", width).cursor?.column, 5 + viewport.caret);
    }
  };
  update(model, { kind: "paste", text: "🇸" }); update(model, { kind: "home" });
  update(model, { kind: "text", text: "🇺" });
  assert.equal(model.ticket, "🇺🇸"); assert.equal(model.cursor, model.ticket.length); boundary();
  update(model, { kind: "clear" }); update(model, { kind: "paste", text: "🇺X🇸" });
  update(model, { kind: "home" }); update(model, { kind: "right" });
  update(model, { kind: "delete" });
  assert.equal(model.ticket, "🇺🇸"); assert.equal(model.cursor, 0); boundary();
  update(model, { kind: "clear" }); update(model, { kind: "paste", text: "🇺X🇸" });
  update(model, { kind: "left" }); update(model, { kind: "backspace" });
  assert.equal(model.ticket, "🇺🇸"); assert.equal(model.cursor, 0); boundary();
  model.ticket = "A😀B"; model.cursor = 2; // A stale interior offset snaps backward, like rendering.
  update(model, { kind: "text", text: "X" });
  assert.equal(model.ticket, "AX😀B"); boundary();
});
test("decoder preserves complete Unicode code points at UTF-8 and UTF-16 chunk boundaries", () => {
  const bytes = Buffer.from("😀e\u0301👩‍💻");
  for (let split = 1; split < bytes.length; split++) {
    const model = initialModel(), events: Key[] = [];
    const decoder = new InputDecoder(key => { events.push(key); update(model, key); });
    const utf8 = new StringDecoder("utf8");
    decoder.feed(utf8.write(bytes.subarray(0, split)));
    decoder.feed(utf8.end(bytes.subarray(split)));
    assert.equal(model.ticket, bytes.toString());
    for (const key of events) if (key.kind === "text") assert.equal(Buffer.from(key.text).toString(), key.text);
  }
  const events: Key[] = [], decoder = new InputDecoder(key => events.push(key));
  decoder.feed("\ud83d"); assert.deepEqual(events, []);
  decoder.feed("\ude00"); assert.deepEqual(events, [{ kind: "text", text: "😀" }]);
});
test("decoder inserts multi-code-point text atomically before existing Unicode suffixes", () => {
  for (const [inserted, suffix] of [["👩‍💻", "🚀"], ["🇺🇸", "🇨🇦"], ["e\u0301", "😀"]]) {
    const model = initialModel();
    update(model, { kind: "paste", text: suffix! }); update(model, { kind: "home" });
    const events: Key[] = [];
    const decoder = new InputDecoder(key => { events.push(key); update(model, key); });
    decoder.feed(inserted!);
    assert.deepEqual(events, [{ kind: "text", text: inserted }]);
    assert.equal(model.ticket, inserted! + suffix!);
    assert.equal(model.cursor, inserted!.length);
    update(model, { kind: "backspace" }); assert.equal(model.ticket, suffix);
  }
});
test("input limits reject whole emoji instead of accepting a surrogate half", () => {
  for (const length of [2046, 2047, 2048]) {
    const model = initialModel();
    update(model, { kind: "paste", text: "A".repeat(length) });
    const decoder = new InputDecoder(key => update(model, key));
    decoder.feed("😀");
    assert.equal(model.ticket, "A".repeat(length) + (length === 2046 ? "😀" : ""));
    assert.equal(Buffer.from(model.ticket).toString(), model.ticket);
    if (length > 2046) assert.match(model.error, /too long/);
  }
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
test("unsupported SS3 function keys never cancel the form or insert suffix characters", () => {
  for (const sequence of ["\x1bOP", "\x1bOQ", "\x1bOR", "\x1bOS", "\x1bO1;2P"]) {
    for (let split = 1; split < sequence.length; split++) {
      const events: Key[] = [], decoder = new InputDecoder(key => events.push(key));
      decoder.feed(sequence.slice(0, split)); decoder.feed(sequence.slice(split) + "x");
      assert.deepEqual(events, [{ kind: "text", text: "x" }]);
    }
    const model = initialModel(); update(model, { kind: "paste", text: "MAIL-1" });
    const effects: unknown[] = [], decoder = new InputDecoder(key => effects.push(update(model, key)));
    for (const char of sequence) decoder.feed(char);
    assert.deepEqual(effects, []); assert.equal(model.ticket, "MAIL-1");
  }
});
test("SS3 prefixes survive Escape timeout and known SS3 navigation still works", () => {
  const events: Key[] = [], decoder = new InputDecoder(key => events.push(key));
  decoder.feed("\x1bO"); decoder.flushEscape(); decoder.feed("P");
  assert.equal(events.length, 0);
  decoder.feed("\x1bOA\x1bOB\x1bOC\x1bOD\x1bOH\x1bOF");
  assert.deepEqual(events.map(key => key.kind), ["up", "down", "right", "left", "home", "end"]);
  decoder.feed("\x1b"); decoder.flushEscape();
  assert.equal(events.at(-1)?.kind, "escape");
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
  const frame = renderFrame(model, "/Users/me/dev/herdr-jira-plugin", 62, { height: 10 });
  const lines = frame.text.split("\r\n");
  assert.doesNotMatch(frame.text, /Start Jira ticket|\/Users\/me|Ctrl\+O|Ctrl\+C/);
  assert.match(frame.text, /Repository +herdr-jira-plugin/);
  assert.match(frame.text, /Paste a ticket ID or URL/);
  assert.match(lines[0]!, /Repository/); // No unused row above the content.
  assert.match(lines[2]!, /┌ Jira ticket ─+┐/);
  assert.equal(cells(lines[2]!), cells(lines[3]!));
  assert.equal(cells(lines[2]!), cells(lines[4]!));
  assert.equal(cells(lines[2]!), cells(lines[6]!)); // Shared controls row aligns to input.
  assert.deepEqual(frame.cursor, { row: 4, column: 5 });
  assert.match(lines[6]!, /Harness +\[ Pi +▾ \] +\[ Start work → \]$/);
  assert.equal(lines.length, 9); // Only one spare interior row, not the old empty lower half.
});
test("all focus, dropdown, feedback and color states stay within the viewport", () => {
  for (const width of [8, 16, 43, 44, 62, 64, 70, 120]) {
    for (const height of [0, 1, 8, 9, 10, 12, 24]) {
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
        if (width < 44 || height < 10) { assert.equal(frame.tooSmall, true); assert.equal(frame.cursor, undefined); }
        else assert.equal(frame.tooSmall, false);
      }
    }
  }
});
test("minimum-size controls and contextual help remain visible in every launch state", () => {
  for (const width of [44, 62]) {
    for (const recover of [false, true]) for (const canOpen of [false, true]) {
      for (const expanded of [false, true]) for (const busy of [false, true]) {
        const model = initialModel();
        model.focus = expanded ? 1 : 2; model.expanded = expanded; model.recover = recover;
        model.error = "A long error with recovery instructions. ".repeat(30);
        const frame = renderFrame(model, "/repo", width, { height: 10, busy, canOpen, status: busy ? "Preparing workspace…" : undefined });
        const lines = frame.text.split("\r\n");
        assert.equal(frame.tooSmall, false);
        assert.match(lines[2]!, /┌ Jira ticket /);
        assert.match(lines[6]!, /Harness +\[ Pi +[▾▴] \]/);
        assert.ok(lines[6]!.endsWith(`[ ${busy ? "Working…" : recover ? "Resume launch →" : "Start work →"} ]`));
        assert.ok(lines.length <= 10);
        assert.equal(lines.filter(line => /Esc (cancel|close)|Please wait/.test(line)).length, 1);
        if (expanded) assert.equal(lines[7]!.indexOf("✓"), lines[6]!.indexOf("[ Pi") + 2);
        if (canOpen && !expanded && !busy) assert.match(lines.at(-1)!, /Ctrl\+O open workspace · Esc cancel/);
        if (busy) assert.doesNotMatch(frame.text, /Ctrl\+O|Esc cancel|Enter resume/);
        for (const line of lines) assert.ok(cells(line) < width);
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
      assert.deepEqual(frame.cursor, { row: 4, column: 5 + viewport.caret });
      assert.ok(frame.text.split("\r\n")[3]!.includes(viewport.text));
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
  assert.match(renderFrame(model, "/repo", 70, { canOpen: true }).text, /Ctrl\+O open workspace/);
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { readFile } from "node:fs/promises";
import { initialModel, update, renderFrame, validateForm, InputDecoder, type Key } from "../src/ui.js";
import { lookupSavedBranch, cancelSavedBranchLookup } from "../src/saved-branch.js";
import { cells, inputViewport } from "../src/display.js";
import { detailLines } from "../src/error-view.js";
import { copyErrorDetails } from "../src/clipboard.js";
import { WorkflowError, SetupError, detailsOf, setupFailureMessage } from "../src/errors.js";
import type { RecordState } from "../src/state.js";

test("manifest declares the compact 64 by 13 popup", async () => {
  const manifest = await readFile(new URL("../herdr-plugin.toml", import.meta.url), "utf8");
  assert.match(manifest, /width = 64\nheight = 13/);
});
test("branch follows normalized ticket until edited, and Ctrl+R restores following", () => {
  const model = initialModel();
  assert.equal(validateForm(model).valid, false);
  assert.equal(update(model, { kind: "enter" }), undefined);
  update(model, { kind: "paste", text: "https://jira.test/browse/mail-1234" });
  assert.equal(model.branch, "MAIL-1234"); assert.equal(validateForm(model).valid, true);
  update(model, { kind: "tab" }); update(model, { kind: "clear" });
  assert.equal(validateForm(model).valid, false); assert.equal(update(model, { kind: "enter" }), undefined);
  update(model, { kind: "text", text: "feature/mail-1234" });
  assert.equal(model.branchEdited, true);
  assert.equal(update(model, { kind: "enter" }), "submit");
  model.focus = 0; update(model, { kind: "clear" }); update(model, { kind: "paste", text: "MAIL-99" });
  assert.equal(model.branch, "feature/mail-1234");
  model.focus = 1; update(model, { kind: "reset_branch" });
  assert.equal(model.branch, "MAIL-99"); assert.equal(model.branchEdited, false);
  model.focus = 0; update(model, { kind: "clear" }); update(model, { kind: "paste", text: "MAIL-2" });
  assert.equal(model.branch, "MAIL-2");
});
test("invalid ticket/branch disables Enter everywhere and editing revokes recovery", () => {
  for (const input of ["", "not a ticket", "MAIL-0", "http://jira.test/browse/MAIL-1"]) {
    const model = initialModel(); update(model, { kind: "paste", text: input });
    for (const focus of [0, 1, 3] as const) { model.focus = focus; assert.equal(update(model, { kind: "enter" }), undefined); }
  }
  const model = initialModel(); update(model, { kind: "paste", text: "MAIL-1" });
  model.focus = 1; model.recover = true; model.error = "Old error"; model.errorDetails = "Old details";
  update(model, { kind: "text", text: " bad" });
  assert.equal(model.recover, false); assert.equal(model.errorDetails, "");
  assert.equal(validateForm(model).valid, false);
  assert.match(renderFrame(model, "/repo", 62).text, /Branch:.*spaces/);
  assert.equal(update(model, { kind: "enter" }), undefined);
  assert.equal(model.focus, 1);
});
test("branch caret and Unicode editing share viewport geometry", () => {
  const model = initialModel(); model.focus = 1;
  update(model, { kind: "paste", text: "feature/漢字/👩‍💻e\u0301" });
  for (const width of [44, 62, 90]) {
    const view = inputViewport(model.branch, model.branchCursor, Math.min(64, width - 5) - 12);
    assert.deepEqual(renderFrame(model, "/repo", width).cursor, { row: 6, column: 13 + view.caret });
  }
  update(model, { kind: "backspace" }); assert.ok(model.branch.endsWith("👩‍💻"));
  update(model, { kind: "left" }); update(model, { kind: "delete" }); assert.equal(model.branch, "feature/漢字/");
});
test("details view scrolls the complete diagnostic and never submits from its overlay", () => {
  const model = initialModel(); update(model, { kind: "paste", text: "MAIL-1" });
  model.error = "Short summary";
  model.errorDetails = Array.from({ length: 80 }, (_, i) => `line ${i}: 漢字👩‍💻 é`).join("\n") + "\nLAST LINE";
  update(model, { kind: "details" }); assert.equal(model.detailsOpen, true);
  assert.equal(update(model, { kind: "enter" }), undefined);
  assert.equal(update(model, { kind: "copy" }), "copy");
  const frame = renderFrame(model, "/repo", 44, { height: 11, color: true });
  assert.equal(frame.cursor, undefined); assert.equal(frame.text.split("\r\n").length, 11);
  for (const line of frame.text.split("\r\n")) assert.ok(cells(line) < 44);
  assert.match(frame.text, /line 0/); assert.doesNotMatch(frame.text, /LAST LINE/);
  update(model, { kind: "end" });
  const end = renderFrame(model, "/repo", 44, { height: 11 });
  assert.match(end.text, /LAST LINE/);
  model.detailsOffset = end.detailsOffset!;
  update(model, { kind: "up" }); assert.equal(model.detailsOffset, end.detailsOffset! - 1);
  update(model, { kind: "home" }); assert.equal(model.detailsOffset, 0);
  update(model, { kind: "escape" }); assert.equal(model.detailsOpen, false);
  assert.equal(model.ticket, "MAIL-1"); assert.equal(update(model, { kind: "escape" }), "cancel");
});
test("details preserve newlines, sanitize controls/credentials, and copy only on request", async () => {
  const diagnostic = "first\nhttps://user:secret@example.test/path?token=private\n\x1b[31msecond\x1b[0m\x07";
  const error = new WorkflowError("Summary", false, diagnostic), text = detailsOf(error);
  assert.match(text, /first\n/); assert.doesNotMatch(text, /secret|private|\x1b|\x07/);
  assert.deepEqual(detailLines("a\n\nb", 10), ["a", "", "b"]);
  assert.equal(detailLines("A漢👩‍💻é", 4).join(""), "A漢👩‍💻é");
  let calls = 0;
  await copyErrorDetails(diagnostic, { platform: "darwin", execute: async (binary, args, options) => {
    calls++; assert.equal(binary, "pbcopy"); assert.deepEqual(args, []); assert.equal(options?.input, text); return "";
  } });
  assert.equal(calls, 1);
  await copyErrorDetails("x", { platform: "linux", env: {}, execute: async (binary, args) => {
    assert.equal(binary, "xclip"); assert.deepEqual(args, ["-selection", "clipboard"]); return "";
  } });
});
test("details and progress remain bounded and color-equivalent at minimum size", () => {
  const model = initialModel(); model.error = "Error"; model.errorDetails = "bad \x1b[2J " + "漢😀".repeat(80);
  for (const detailsOpen of [false, true]) for (const busy of [false, true]) {
    model.detailsOpen = detailsOpen;
    const options = { height: 11, busy, base: "origin/trunk (aaaaaaaa)", status: busy ? "3/4 Starting Pi…" : undefined };
    const plain = renderFrame(model, "/repo", 44, options), colored = renderFrame(model, "/repo", 44, { ...options, color: true });
    assert.equal(stripVTControlCharacters(colored.text), plain.text);
    assert.ok(plain.text.split("\r\n").length <= 11);
    for (const line of plain.text.split("\r\n")) assert.ok(cells(line) < 44);
    if (busy) { assert.match(plain.text, /Base +origin\/trunk/); assert.match(plain.text, /3\/4 Starting Pi/); assert.equal(plain.cursor, undefined); }
  }
});
test("elapsed time stays visible in existing feedback rows without changing idle/errors or controls", () => {
  const model = initialModel(); update(model, { kind: "paste", text: "MAIL-1" });
  for (const width of [44, 62]) for (const status of ["3/5 Installing dependencies…", "3/5 Installing " + "漢字👩‍💻".repeat(80)]) {
    for (const seconds of [0, 42, 300, 1800]) {
      const options = { height: 11, busy: true, status, elapsedSeconds: seconds };
      const frame = renderFrame(model, "/repo", width, options);
      assert.match(frame.text, new RegExp(` · ${seconds}s`));
      assert.ok(frame.text.split("\r\n").length <= 11);
      for (const line of frame.text.split("\r\n")) assert.ok(cells(line) < width);
      assert.equal(stripVTControlCharacters(renderFrame(model, "/repo", width, { ...options, color: true }).text), frame.text);
      assert.doesNotMatch(frame.text, /Ctrl\+S|Retry setup/);
    }
  }
  model.error = "Python version mismatch";
  assert.equal(renderFrame(model, "/repo", 44, { elapsedSeconds: 42 }).text, renderFrame(model, "/repo", 44).text);
  model.detailsOpen = true; model.errorDetails = "Full diagnostic";
  assert.equal(renderFrame(model, "/repo", 44, { elapsedSeconds: 42 }).text, renderFrame(model, "/repo", 44).text);
});
test("setup cause is short, sanitized and visible with existing recovery controls", () => {
  const cause = "Python >=3.12 required; found 3.11.";
  const model = initialModel(); update(model, { kind: "paste", text: "MAIL-1" });
  model.error = setupFailureMessage(new Error(`\x1b[31m${cause}\x1b[0m\nLong installer diagnostic`)); model.setupRecovery = true;
  assert.equal(model.error, cause);
  const frame = renderFrame(model, "/repo", 44, { height: 11, canOpen: true });
  assert.ok(frame.text.includes(cause)); assert.match(frame.text, /Retry setup/); assert.match(frame.text, /Ctrl\+S Start Pi anyway/);
  assert.match(frame.text, /Ctrl\+O open · Ctrl\+D more/);
  const secret = setupFailureMessage(new Error("https://user:secret@host.test/?token=hidden Authorization: Bearer private"));
  assert.doesNotMatch(secret, /secret|hidden|private/); assert.match(secret, /redacted/);
  assert.ok(Array.from(setupFailureMessage(new Error("漢😀".repeat(400)))).length <= 240);
  assert.equal(setupFailureMessage(new Error("\n\t")), "Dependency setup failed; see details.");
});
test("setup recovery has a separate explicit skip action, compact row and busy/details gating", () => {
  const model = initialModel(); update(model, { kind: "paste", text: "MAIL-1" });
  model.error = "Generic recoverable failure"; model.recover = true;
  assert.equal(update(model, { kind: "skip_setup" }), undefined);
  assert.doesNotMatch(renderFrame(model, "/repo", 64).text, /Ctrl\+S/);
  const error = new SetupError("Setup failed", "private diagnostic");
  model.error = error.message; model.errorDetails = detailsOf(error); model.setupRecovery = error instanceof SetupError;
  assert.equal(update(model, { kind: "skip_setup" }), "skip_setup");
  assert.equal(update(model, { kind: "enter" }), "submit");
  for (const [width, height] of [[44, 11], [64, 13]]) for (const busy of [false, true]) for (const expanded of [false, true]) {
    model.expanded = expanded;
    const options = { height, busy, canOpen: true };
    const frame = renderFrame(model, "/repo", width!, options), colored = renderFrame(model, "/repo", width!, { ...options, color: true });
    assert.equal(stripVTControlCharacters(colored.text), frame.text);
    const lines = frame.text.split("\r\n"); assert.ok(lines.length <= height!);
    for (const line of lines) assert.ok(cells(line) < width!);
    if (busy) { assert.doesNotMatch(frame.text, /Ctrl\+S|Retry setup/); assert.equal(frame.cursor, undefined); }
    else { assert.match(lines[6]!, /Ctrl\+S Start Pi anyway/); assert.match(frame.text, /Retry setup/); if (!expanded) assert.match(frame.text, /Ctrl\+O open · Ctrl\+D more/); }
  }
  for (const kind of ["skip_setup", "enter", "open", "details"] as const) assert.equal(update(model, { kind }, true), undefined);
  update(model, { kind: "details" });
  for (const kind of ["skip_setup", "enter", "open"] as const) assert.equal(update(model, { kind }), undefined);
  assert.doesNotMatch(renderFrame(model, "/repo", 44).text, /Start Pi anyway/);
  assert.equal(update(model, { kind: "copy" }), "copy");
});
test("ticket, branch, harness edits and reset revoke every recovery approval", () => {
  for (const edit of ["ticket", "branch", "harness", "reset"] as const) {
    const model = initialModel(); update(model, { kind: "paste", text: "MAIL-1" });
    model.recover = true; model.setupRecovery = true; model.error = "failed"; model.errorDetails = "details";
    if (edit === "ticket") { model.focus = 0; update(model, { kind: "text", text: "0" }); }
    if (edit === "branch") { model.focus = 1; update(model, { kind: "text", text: "-custom" }); }
    if (edit === "reset") { model.focus = 1; update(model, { kind: "reset_branch" }); }
    if (edit === "harness") { model.focus = 2; model.expanded = true; update(model, { kind: "down" }); }
    assert.equal(model.recover, false); assert.equal(model.setupRecovery, false); assert.equal(model.errorDetails, "");
    assert.equal(update(model, { kind: "skip_setup" }), undefined);
  }
});
test("new shortcuts decode across fragmented sequences", () => {
  const events: Key[] = [], decoder = new InputDecoder(key => events.push(key));
  for (const char of "\x04\x19\x12\x13\x1b[5~\x1b[6~") decoder.feed(char);
  assert.deepEqual(events.map(key => key.kind), ["details", "copy", "reset_branch", "skip_setup", "pageup", "pagedown"]);
});

const saved = (key: string, branch: string) => ({ repo: "/repo", ticket: { key, site: "mcp-default", reference: key }, branch } as RecordState);
test("saved custom branch is populated before submission; manual edits are never overwritten", async () => {
  const model = initialModel(); update(model, { kind: "paste", text: "MAIL-1" });
  let resolve!: (record: RecordState) => void;
  const pending = lookupSavedBranch(model, "/repo", () => new Promise(r => { resolve = r; }));
  assert.equal(validateForm(model).valid, false); assert.equal(update(model, { kind: "enter" }), undefined);
  resolve(saved("MAIL-1", "feature/Mail-1")); await pending;
  assert.equal(model.branch, "feature/Mail-1"); assert.equal(validateForm(model).valid, true);
  const later = lookupSavedBranch(model, "/repo", () => new Promise(r => { resolve = r; }));
  model.focus = 1; update(model, { kind: "clear" }); update(model, { kind: "text", text: "my-branch" });
  resolve(saved("MAIL-1", "old-branch")); await later;
  assert.equal(model.branch, "my-branch");
});
test("resetting the branch cancels a still-pending saved-branch lookup", async () => {
  const model = initialModel(); update(model, { kind: "paste", text: "MAIL-1" });
  let resolve!: (record: RecordState) => void;
  const pending = lookupSavedBranch(model, "/repo", () => new Promise(r => { resolve = r; }));
  model.focus = 1; update(model, { kind: "reset_branch" }); cancelSavedBranchLookup(model);
  resolve(saved("MAIL-1", "saved-custom")); await pending;
  assert.equal(model.branch, "MAIL-1"); assert.equal(validateForm(model).valid, true);
});
test("stale lookup and wrong-site records never overwrite the current ticket branch", async () => {
  const model = initialModel(); update(model, { kind: "paste", text: "MAIL-1" });
  let resolve!: (record: RecordState) => void;
  const first = lookupSavedBranch(model, "/repo", () => new Promise(r => { resolve = r; }));
  update(model, { kind: "clear" }); update(model, { kind: "paste", text: "MAIL-2" });
  await lookupSavedBranch(model, "/repo", async () => saved("MAIL-2", "feature/MAIL-2"));
  resolve(saved("MAIL-1", "stale")); await first;
  assert.equal(model.branch, "feature/MAIL-2");
  await lookupSavedBranch(model, "/repo", async () => ({ ...saved("MAIL-2", "wrong-site"), ticket: { key: "MAIL-2", site: "other.test", reference: "MAIL-2" } }));
  assert.equal(model.branch, "feature/MAIL-2");
});

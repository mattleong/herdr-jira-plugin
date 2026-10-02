import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTicket, agentName } from "../src/ticket.js";
import { parseConfig } from "../src/config.js";
import { getHarness } from "../src/harnesses.js";

test("normalizes keys and preserves Jira site identity", () => {
  assert.deepEqual(parseTicket(" mail-1234 "), { key: "MAIL-1234", site: "mcp-default", reference: "MAIL-1234" });
  assert.deepEqual(parseTicket("https://Example.atlassian.net/browse/mail-1234?x=1#comments"), { key: "MAIL-1234", site: "example.atlassian.net", reference: "https://example.atlassian.net/browse/MAIL-1234" });
  assert.equal(parseTicket("MAIL-1234", "example.atlassian.net").site, "example.atlassian.net");
});
test("rejects executable text, unsafe URLs and malformed tickets", () => {
  for (const value of ["", "MAIL-0", "../MAIL-123", "MAIL-123;rm", "http://jira.test/browse/MAIL-123", "https://u:p@jira.test/browse/MAIL-123", "https://jira.test/other/MAIL-123", "MAIL-123\nOTHER-2", "\x1bMAIL-1", "https://jira.test:123/browse/MAIL-123"]) assert.throws(() => parseTicket(value));
});
test("agent aliases are valid, bounded and repository/site-specific", () => {
  const ticket = parseTicket("VERYLONGPROJECTNAME0123456789-123456");
  assert.match(agentName("/a", ticket), /^[a-z][a-z0-9_-]{0,31}$/);
  assert.notEqual(agentName("/a", ticket), agentName("/b", ticket));
  assert.notEqual(agentName("/a", ticket), agentName("/a", { ...ticket, site: "other.test" }));
  assert.notEqual(agentName("/a", parseTicket("VERYLONGPROJECTNAME-1")), agentName("/a", parseTicket("VERYLONGPROJECTNAME-2")));
});
test("harness registry exposes Pi only and rejects injected kinds", () => {
  assert.equal(getHarness("pi").label, "Pi");
  assert.throws(() => getHarness("claude"));
  assert.throws(() => getHarness("--anything"));
});
test("setup config is backward-compatible, bounded, declarative and contained", () => {
  assert.equal(parseConfig({}).setupTimeoutMs, 300000);
  for (const setupTimeoutMs of [3001, 1800000]) assert.equal(parseConfig({ setupTimeoutMs }).setupTimeoutMs, setupTimeoutMs);
  for (const setupTimeoutMs of [0, 3000, 1800001, 3001.5, "300000"]) assert.throws(() => parseConfig({ setupTimeoutMs }));
  const wrap = (setup: unknown) => ({ repos: { "/repo/.git": { setup } } });
  for (const manager of ["npm", "pnpm", "yarn", "bun", "uv", "poetry", "requirements", "go", "auto", "none"]) {
    assert.equal(parseConfig(wrap({ manager })).repos["/repo/.git"]!.setup!.manager, manager);
  }
  assert.deepEqual(parseConfig(wrap({ directory: "service/api", python: "/opt/Python 3/bin/python3", requirements: ["service/requirements.txt", "service/requirements-dev.txt"] })).repos["/repo/.git"]!.setup,
    { directory: "service/api", python: "/opt/Python 3/bin/python3", requirements: ["service/requirements.txt", "service/requirements-dev.txt"] });
  for (const setup of [null, [], "npm", { command: "evil" }, { manager: "pip" }, { manager: [] }, { python: "python -m pip" }, { python: "$(evil)" }, { python: "-python" }, { python: "./python" }, { requirements: [] }, { requirements: "requirements.txt" }]) assert.throws(() => parseConfig(wrap(setup)));
  for (const path of ["", "../outside", "inside/../../outside", "/absolute", "C:\\absolute", "foo\\..\\bar", "x\n", "--flag"]) {
    assert.throws(() => parseConfig(wrap({ directory: path })));
    assert.throws(() => parseConfig(wrap({ requirements: [path] })));
  }
  assert.equal(parseConfig(wrap({ directory: ".", python: "python3.12" })).repos["/repo/.git"]!.setup!.directory, ".");
});
test("validates config and keeps Pi interactive", () => {
  assert.equal(parseConfig({ defaultJiraSite: "https://jira.test", piArgs: ["--model", "provider/model"] }).defaultJiraSite, "jira.test");
  for (const config of [{ wrong: true }, { piArgs: ["--print"] }, { piArgs: ["--model", "x", "do work"] }, { piArgs: ["--resume", "x"] }, { piArgs: ["--no-extensions"] }, { startupTimeoutMs: 3000 }, { repos: { "/a": { remote: "--evil" } } }]) assert.throws(() => parseConfig(config));
});

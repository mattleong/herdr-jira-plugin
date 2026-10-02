import { test } from "node:test";
import assert from "node:assert/strict";
import { branchError, validateBranch } from "../src/branch.js";

test("branch validator accepts literal local names without changing case", () => {
  for (const branch of ["MAIL-1", "feature/Mail-1", "fix_123", "release/v1.2", "漢字/変更", "emoji/👩‍💻"]) {
    assert.equal(branchError(branch), undefined, branch); assert.equal(validateBranch(branch), branch);
  }
});
test("branch validator rejects Git expressions, controls, options, invalid paths and long names", () => {
  for (const branch of ["", "HEAD", "@", "@{-1}", "refs/heads/x", "-x", "a b", "a\nb", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a..b", "a@{b", "/a", "a/", "a//b", ".a", "a/.b", "a.lock", "a.", "a".repeat(241), "漢".repeat(81)]) {
    assert.ok(branchError(branch), branch); assert.throws(() => validateBranch(branch), branch);
  }
});

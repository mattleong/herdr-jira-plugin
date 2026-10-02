import { test } from "node:test";
import assert from "node:assert/strict";
import { startElapsed } from "../src/elapsed.js";

test("one monotonic attempt clock redraws each second, stops, and restarts at zero", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = 100, redraws = 0;
  const first = startElapsed(() => redraws++, () => now);
  assert.equal(first.seconds(), 0);
  now += 999; t.mock.timers.tick(999);
  assert.equal(first.seconds(), 0); assert.equal(redraws, 0);
  now += 1; t.mock.timers.tick(1);
  assert.equal(first.seconds(), 1); assert.equal(redraws, 1);
  // Reading elapsed time when a progress label changes does not restart the clock.
  now += 4000; t.mock.timers.tick(4000);
  assert.equal(first.seconds(), 5); assert.equal(redraws, 5);
  first.stop(); first.stop();
  now += 3000; t.mock.timers.tick(3000); assert.equal(redraws, 5);
  const retry = startElapsed(() => redraws++, () => now);
  assert.equal(retry.seconds(), 0);
  now += 1000; t.mock.timers.tick(1000);
  assert.equal(retry.seconds(), 1); assert.equal(redraws, 6);
  retry.stop(); t.mock.timers.tick(5000); assert.equal(redraws, 6);
});

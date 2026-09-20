import { test } from "vitest";
import assert from "node:assert/strict";
import { compare, validMetrics, wilson } from "../app/_lib/experiment.ts";

const a = { spend: 350, clicks: 1000, leads: 50 };
const b = { spend: 350, clicks: 1000, leads: 110 };

test("invalid counts and non-finite costs are rejected", () => {
  for (const m of [
    { ...a, spend: Infinity },
    { ...a, leads: 1001 },
    { ...a, clicks: 1.5 },
    { ...a, leads: -1 },
  ]) {
    assert.equal(validMetrics(m), false);
    assert.equal(compare(m, b, 7, 7).winner, null);
  }
});
test("no early winner or winner with insufficient events", () => {
  assert.equal(compare(a, b, 6, 7).winner, null);
  assert.equal(compare({ ...a, leads: 9 }, b, 7, 7).winner, null);
  assert.equal(compare(a, b, NaN, 7).winner, null);
});
test("separated rates identify the same arm regardless of position", () => {
  assert.equal(compare(a, b, 7, 7).winner, "B");
  assert.equal(compare(b, a, 7, 7).winner, "A");
  assert.equal(compare(a, { ...a, leads: 51 }, 7, 7).winner, null);
});
test("Wilson intervals handle empty and boundary observations", () => {
  assert.deepEqual(wilson(0, 0), [0, 1]);
  assert.ok(wilson(0, 100)[1] < 0.04);
  assert.ok(wilson(100, 100)[0] > 0.96);
  const [low, high] = wilson(50, 100);
  assert.ok(low > 0.4 && low < 0.41);
  assert.ok(high > 0.59 && high < 0.6);
});

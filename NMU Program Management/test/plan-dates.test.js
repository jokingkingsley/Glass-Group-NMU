import test from "node:test";
import assert from "node:assert/strict";
import { planDueDates } from "../plan-dates.js";

test("keeps template dates when there is enough lead time", () => {
  const plan = planDueDates("2027-03-01", [-30, -7, 0, 10], "2026-11-27");
  assert.equal(plan.compressed, false);
  assert.deepEqual(plan.dates, ["2027-01-30", "2027-02-22", "2027-03-01", "2027-03-11"]);
});

test("compresses pre-start steps into the remaining lead time; nothing is overdue", () => {
  // Program starts 61 days from today; the template wants 120 days of lead time.
  const plan = planDueDates("2027-01-27", [-120, -60, -30, -1, 0, 14], "2026-11-27");
  assert.equal(plan.compressed, true);
  assert.equal(plan.leadDays, 61);
  assert.equal(plan.neededDays, 120);
  assert.ok(plan.dates.every((date) => date >= "2026-11-27"));
  assert.deepEqual(plan.dates.slice(4), ["2027-01-27", "2027-02-10"], "steps from the start date on are unchanged");
  assert.deepEqual([...plan.dates].slice(0, 4), [...plan.dates.slice(0, 4)].sort(), "order is kept");
  assert.equal(plan.dates[0], "2026-11-27");
});

test("a program starting today puts all prep steps on today", () => {
  const plan = planDueDates("2026-11-27", [-10, -1, 5], "2026-11-27");
  assert.deepEqual(plan.dates, ["2026-11-27", "2026-11-27", "2026-12-02"]);
});

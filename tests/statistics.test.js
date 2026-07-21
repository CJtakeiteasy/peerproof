import test from "node:test";
import assert from "node:assert/strict";
import { linearRegression, twoSidedStudentTPValue } from "../src/statistics.js";

test("Student t p-value matches a known two-sided reference", () => {
  const p = twoSidedStudentTPValue(2.306, 8);
  assert.ok(Math.abs(p - 0.05) < 0.001, `expected approximately 0.05, received ${p}`);
});

test("synthetic full sample reproduces the reported regression", () => {
  const rows = [
    [1, 4], [2, 6], [3, 5], [4, 7], [5, 4],
    [6, 6], [7, 5], [8, 7], [9, 4], [20, 30],
  ].map(([x, y], index) => ({ id: `P${index + 1}`, x, y }));
  const result = linearRegression(rows);
  assert.equal(result.n, 10);
  assert.ok(Math.abs(result.slope - 1.27619) < 1e-5);
  assert.ok(result.pValue < 0.001);
});

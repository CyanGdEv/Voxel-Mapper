import test from "node:test";
import assert from "node:assert/strict";
import { appendArrayValues } from "../src/lib/array-utils.mjs";

test("appendArrayValues safely appends production-scale planning candidate arrays", () => {
  const target = [{ id: "existing" }];
  const values = Array.from({ length: 250_000 }, (_, index) => ({ id: `candidate-${index}` }));

  const returned = appendArrayValues(target, values);

  assert.equal(returned, target);
  assert.equal(target.length, 250_001);
  assert.equal(target[0].id, "existing");
  assert.equal(target.at(-1).id, "candidate-249999");
});

test("appendArrayValues handles missing values without changing the target", () => {
  const target = [1, 2, 3];
  assert.equal(appendArrayValues(target, null), target);
  assert.deepEqual(target, [1, 2, 3]);
});

test("appendArrayValues rejects a non-array target", () => {
  assert.throws(() => appendArrayValues({}, [1]), /target must be an array/);
});

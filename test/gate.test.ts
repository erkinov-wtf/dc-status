import { describe, expect, it } from "vitest";
import { shouldRun } from "../src/gate";

const MIN = 60_000;

describe("shouldRun", () => {
  it("runs on minutes divisible by the interval", () => {
    expect(shouldRun(100 * MIN, 5)).toBe(true);
    expect(shouldRun(105 * MIN, 5)).toBe(true);
  });

  it("skips minutes not divisible by the interval", () => {
    expect(shouldRun(101 * MIN, 5)).toBe(false);
    expect(shouldRun(104 * MIN, 5)).toBe(false);
  });

  it("treats a few seconds past the minute as that minute", () => {
    expect(shouldRun(105 * MIN + 3_400, 5)).toBe(true);
    expect(shouldRun(106 * MIN + 3_400, 5)).toBe(false);
  });

  it("runs every minute when the interval is 1", () => {
    for (let m = 0; m < 10; m++) expect(shouldRun(m * MIN, 1)).toBe(true);
  });

  it("works for an interval that does not divide 60", () => {
    expect(shouldRun(63 * MIN, 7)).toBe(true);
    expect(shouldRun(64 * MIN, 7)).toBe(false);
  });
});

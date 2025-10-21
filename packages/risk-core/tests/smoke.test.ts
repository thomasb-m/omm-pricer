import { describe, it, expect } from "vitest";
import { dot } from "../src/index.js";

describe("@risk-core smoke", () => {
  it("dot product works", () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });
});

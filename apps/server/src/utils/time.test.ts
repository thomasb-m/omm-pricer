import { timeToExpiryYears } from "./time";

describe("timeToExpiryYears", () => {
  test("converts ~30 days to ~0.082 years", () => {
    const now = Date.now();
    const ms30 = 30 * 24 * 3600 * 1000;
    const T = timeToExpiryYears(now + ms30, now);
    expect(T).toBeGreaterThan(0.08 - 0.005);
    expect(T).toBeLessThan(0.09 + 0.005);
  });

  test("non-negative clamp", () => {
    const now = Date.now();
    const T = timeToExpiryYears(now - 1234, now);
    expect(T).toBe(0);
  });
});

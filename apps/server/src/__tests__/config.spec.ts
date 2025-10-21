import { describe, it, expect } from "vitest";
import { loadConfig } from "../config/configManager";

describe("config manager", () => {
  it("loads and freezes config", () => {
    const cfg = loadConfig();
    expect(cfg).toBeTruthy();
    expect(Object.isFrozen(cfg)).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { Fit } from "../src/index.js";

describe("artifact builder", () => {
  it("emits a minimal JSON-serializable artifact", () => {
    const art = Fit.buildFitArtifact([-0.5,0,0.5],[0.1,0.05,0.1],"demo",{foo:42});
    const s = JSON.stringify(art);
    expect(s.length).toBeGreaterThan(10);
    expect(art.meta.method).toBe("demo");
  });
});

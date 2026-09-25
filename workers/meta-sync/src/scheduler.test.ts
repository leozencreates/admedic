import { describe, expect, it } from "vitest";

import { createMetaSyncScheduler, start, stop } from "./scheduler";

describe("meta-sync scheduler", () => {
  it("start/stop/run dışarı aktarılır ve çağrılabilir", () => {
    expect(typeof start).toBe("function");
    expect(typeof stop).toBe("function");
    const job = createMetaSyncScheduler();
    expect(typeof job.run).toBe("function");
  });

  it("start çağrısı hata fırlatmadan geri döner (stop ile temizlenir)", () => {
    expect(() => start()).not.toThrow();
    stop();
  });
});
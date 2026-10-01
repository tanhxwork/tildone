import { describe, expect, it } from "bun:test";
import type { Environment } from "../src/types";
import { nextEnvironment } from "../src/utils/environment";

const of = (...envs: Environment[]) => envs.map((environment) => ({ environment }));

describe("nextEnvironment", () => {
  it("takes the first environment no project uses", () => {
    expect(nextEnvironment(of("meadow", "city"))).toBe("desert");
  });

  it("fills a gap before later environments", () => {
    expect(nextEnvironment(of("meadow", "desert", "snow"))).toBe("city");
  });

  it("cycles by project count once all five are used", () => {
    expect(nextEnvironment(of("meadow", "city", "desert", "snow", "autumn"))).toBe("meadow");
    expect(nextEnvironment(of("meadow", "city", "desert", "snow", "autumn", "meadow", "city"))).toBe("desert");
  });
});

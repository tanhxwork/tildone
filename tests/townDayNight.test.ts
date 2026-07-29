import { describe, expect, it } from "bun:test";
import { MAX_DARK, dayNightPhase } from "../src/town/daynight";

describe("dayNightPhase", () => {
  it("is full day at noon", () => {
    const { darkness, glow } = dayNightPhase(12);
    expect(darkness).toBe(0);
    expect(glow).toBe(0);
  });

  it("is deepest night at midnight", () => {
    const { darkness, glow } = dayNightPhase(0);
    expect(darkness).toBe(MAX_DARK);
    expect(glow).toBe(1);
  });

  it("darkness decreases monotonically toward noon", () => {
    // Note: hour 9 is already inside the zero-darkness daylight plateau under
    // the exact formula (elevation crosses the 0.25 threshold around h~6.97),
    // same as noon — so it is not a useful monotonic checkpoint. Using 0, 6,
    // 12 instead, which are strictly decreasing.
    const d0 = dayNightPhase(0).darkness;
    const d6 = dayNightPhase(6).darkness;
    const d12 = dayNightPhase(12).darkness;
    expect(d0).toBeGreaterThan(d6);
    expect(d6).toBeGreaterThan(d12);
  });

  it("dusk (18) is in the warm band", () => {
    const { tint, darkness } = dayNightPhase(18);
    expect(tint).toBe(0xff8a4c);
    expect(darkness).toBeGreaterThan(0);
    expect(darkness).toBeLessThan(0.4);
  });

  it("deep night (0) tint is deep blue", () => {
    const { tint } = dayNightPhase(0);
    expect(tint).toBe(0x0a1633);
  });

  it("normalizes hour 24 to 0 and -1 to 23", () => {
    expect(dayNightPhase(24)).toEqual(dayNightPhase(0));
    expect(dayNightPhase(-1)).toEqual(dayNightPhase(23));
  });

  // `night` is what the sim reads to send quiet agents to bed, so it has to mean
  // properly dark rather than merely dim — sending the town to bed at dusk would
  // empty the plaza hours early.
  it.each([0, 1, 2, 3, 22, 23])("is night at %p", (h) => {
    expect(dayNightPhase(h).night).toBe(true);
  });

  it.each([8, 12, 16, 18])("is not night at %p", (h) => {
    expect(dayNightPhase(h).night).toBe(false);
  });

  it("is not night while the sky is still only dusk-warm", () => {
    for (let h = 0; h < 24; h += 0.25) {
      const { tint, night } = dayNightPhase(h);
      if (tint === 0xff8a4c) expect(night).toBe(false); // the warm dawn/dusk band
    }
  });
});

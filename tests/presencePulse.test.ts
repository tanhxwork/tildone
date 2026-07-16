import { describe, expect, it } from "bun:test";
import { isActivelyWorking, isRecentPresence } from "../src/utils/dates";

// Two windows, one signal. Presence (12h) decides whether the card shows an agent
// at all; the active window (2 min) decides only whether its mark spins+pulses.
// The animation can only under-claim: it needs a genuinely fresh write to switch on.

describe("presence windows", () => {
  it("a write seconds ago is actively working", () => {
    const secondsAgo = new Date(Date.now() - 30 * 1000).toISOString();
    expect(isActivelyWorking(secondsAgo)).toBe(true);
  });

  it("a write hours ago is still presence, but no longer actively working", () => {
    const hoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(isRecentPresence(hoursAgo)).toBe(true);
    expect(isActivelyWorking(hoursAgo)).toBe(false);
  });

  it("a write past the presence window is neither", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(isRecentPresence(yesterday)).toBe(false);
    expect(isActivelyWorking(yesterday)).toBe(false);
  });

  it("a garbage timestamp never animates", () => {
    expect(isActivelyWorking("not-a-date")).toBe(false);
  });
});

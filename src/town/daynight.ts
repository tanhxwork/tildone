// Maps an hour-of-day to a night-overlay darkness and tint color, for a
// day/night cycle drawn over the town. Pure and deterministic — callers pass
// the hour (no Date calls here) so the phase is easy to test and to drive
// from a fast-forwarded clock.

export interface DayNight {
  /** Alpha of the night overlay, 0 (full day) .. MAX_DARK (deepest night). */
  darkness: number;
  /** Overlay tint color (hex int): warm at dawn/dusk, deep blue at night. */
  tint: number;
  /** 0..1 window-glow strength for lit windows — rises with darkness (so lit
   *  offices read strongest at night, invisible at noon). */
  glow: number;
  /** True once it is properly dark — not merely dusk. The sim reads this to send
   *  quiet agents home to bed (a working one stays at its desk whatever the
   *  hour). Derived here so the renderer's night and the sim's night can never
   *  drift apart: the town going dark and the town going to bed are the same
   *  event, and two thresholds would eventually disagree about when it happened. */
  night: boolean;
}

export const MAX_DARK = 0.55;
/** How dark it has to be to count as night — past dusk, short of deepest. */
const NIGHT_AT = MAX_DARK * 0.7;

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** hour in [0,24) (fractional ok). Pure and deterministic. */
export function dayNightPhase(hour: number): DayNight {
  const h = ((hour % 24) + 24) % 24;
  const elevation = Math.cos(((h - 12) / 24) * 2 * Math.PI); // +1 at noon(12), -1 at midnight(0/24)
  // Darkness ramps in only once the sun dips below elevation 0.25, reaching MAX_DARK at elevation -1.
  const darkness =
    elevation >= 0.25 ? 0 : clamp01((0.25 - elevation) / 1.25) * MAX_DARK;
  // Warm band: sun near/below the horizon but not yet deep night (dawn/dusk glow).
  const warm = darkness > 0.05 && darkness < 0.4;
  const tint = warm ? 0xff8a4c : 0x0a1633;
  const glow = clamp01(darkness / MAX_DARK); // 0 at noon, 1 at deepest night

  return { darkness, tint, glow, night: darkness >= NIGHT_AT };
}

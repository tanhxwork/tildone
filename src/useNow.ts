import { useEffect, useState } from "react";

/** The current time in epoch ms, refreshed every `everyMs`. A view that ages
 *  things by the clock (the focus compass: moving, stalled, quiet) reads this, so
 *  an app left open on a quiet board still moves cards between windows. */
export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

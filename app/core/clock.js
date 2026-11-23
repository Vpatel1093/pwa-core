// Hybrid clock: timestamps follow the device clock but never repeat or go
// backwards, and always land after anything already seen from other devices.
// So "which edit came last" stays sane even when a phone clock is off.

// Timestamps further ahead of this device's clock than this are ignored, so
// one device with a wildly wrong clock (or a tampered backup) can't drag
// every device's clock into the future for good.
export const MAX_SKEW_MS = 24 * 60 * 60 * 1000;

export function createClock({ now = () => Date.now(), last = 0 } = {}) {
  if (!Number.isSafeInteger(last) || last > now() + MAX_SKEW_MS) last = 0;
  return {
    get last() {
      return last;
    },
    tick() {
      last = Math.max(now(), last + 1);
      return last;
    },
    observe(ts) {
      if (Number.isSafeInteger(ts) && ts > last && ts <= now() + MAX_SKEW_MS) last = ts;
    },
  };
}

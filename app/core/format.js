// Small display helpers.

export function ago(then, now = Date.now()) {
  if (then == null) return 'never';
  const s = Math.max(0, (now - then) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// Changes waiting longer than this may exist only on this device.
export const STALE_SYNC_MS = 24 * 60 * 60 * 1000;

// The header's sync button: short text, whether to show the quiet "waiting a
// while" cue, and a fuller label for screen readers (the cue is visual).
export function syncLabel(s, now = Date.now()) {
  let text;
  if (s.manual) text = 'Syncing…';
  else if (s.status === 'error') text = 'Sync problem · see Settings';
  // The count comes first so a narrow phone header cuts the reason, not the number.
  else if (s.status === 'offline') text = s.pending ? `${s.pending} not synced · can't reach server` : `Can't reach server · synced ${ago(s.lastSyncAt, now)}`;
  else if (s.lastSyncAt) text = `Synced ${ago(s.lastSyncAt, now)}`;
  else text = 'Not synced yet';
  const stale = s.pending > 0 && now - (s.lastSyncAt ?? 0) > STALE_SYNC_MS;
  return { text, stale, label: `${text}.${stale ? ' Waiting more than a day.' : ''} Sync now` };
}

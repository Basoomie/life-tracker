// §5.6 — Active / inactive items.
//
// An item could previously only exist or be deleted.  A habit being *paused* is
// neither: deleting and re-creating it later loses the configuration and, worse,
// splits one habit's history across two ids — the same fragmentation §5.5 was
// written to fix.
//
// deactivated_at is orthogonal to archived_at, not a replacement for it.  They answer
// different questions and are logged as different decisions ("I paused this" vs "I'm
// done with this"), so an item can be inactive, deleted, or both, and a later reader
// can always tell which happened.
//
// This column is the *scheduling* answer ("is it off right now") and nothing more.
// WHICH DAYS an item was paused on is derived by replaying its template_deactivated /
// template_reactivated events (§5.6) — a single timestamp cannot answer that, and the
// answer is impossible to backfill, so the events carry an applies_to_day from day one.
//
// The partial index serves the two list queries the UI makes constantly: the active
// items every scheduling path walks, and the inactive list the user restores from.

export const name = '0015_item_deactivation'

export const up = `
ALTER TABLE items ADD COLUMN deactivated_at TIMESTAMPTZ;

CREATE INDEX items_user_active   ON items (user_id)
  WHERE archived_at IS NULL AND deactivated_at IS NULL;
CREATE INDEX items_user_inactive ON items (user_id)
  WHERE archived_at IS NULL AND deactivated_at IS NOT NULL;
`

export const down = `
DROP INDEX IF EXISTS items_user_inactive;
DROP INDEX IF EXISTS items_user_active;
ALTER TABLE items DROP COLUMN IF EXISTS deactivated_at;
`

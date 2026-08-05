// §5.5 — Multiple schedules per item.
//
// Previously an item carried exactly one recurrence rule and one timing block, so a
// habit performed at several different times had to be split into several items.
// That tracked fine but fragmented the record: v2 computed a separate adherence,
// streak and recommendation history per fragment.
//
// A *schedule* is now the unit that answers "when does this happen" — its own
// recurrence rule, anchor day, timing precision/times and planned duration.  The
// item keeps everything that describes the habit rather than one of its slots
// (name, category, quota target, disposition policy, prerequisites, parent).
//
// Occurrence identity therefore becomes (item, day, schedule): two schedules due on
// the same day produce two independently-completable occurrences.
//
// This migration is a clean cut, not a shadow: the moved columns are dropped from
// `items` so there is never a second source of truth for an item's timing.
// Every pre-existing item is backfilled with exactly one schedule (sort_order 0)
// carrying its current values, and every pre-existing occurrence is pointed at it —
// so behaviour is bit-for-bit unchanged until a second schedule is actually added.
//
// Note the backfill deliberately leaves item_schedules.archived_at NULL even for
// archived items: a schedule's archived_at means "the user removed this slot"
// (§5.5), which is a different fact from "the item was deleted".  Archived items
// are already filtered out by item-level queries.

export const name = '0014_item_schedules'

export const up = `
CREATE TABLE item_schedules (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID        NOT NULL REFERENCES users(id),
  item_id              UUID        NOT NULL REFERENCES items(id),

  -- §5.5 — optional user-facing name for the slot ("Morning block"); live, not
  -- snapshotted, so a rename applies everywhere at once (same rule as sort_order).
  label                TEXT,

  -- §5.1 — recurrence rule for THIS slot; NULL = one-time
  recurrence_rule      JSONB,
  anchor_day           DATE,

  -- §6.5 — timing precision is a property of the schedule, not the item
  timing_precision     TEXT        NOT NULL DEFAULT 'none'
                         CHECK (timing_precision IN ('none', 'bucket', 'point', 'range')),
  timing_bucket_id     UUID        REFERENCES buckets(id),
  timing_start_time    TIME,
  timing_end_time      TIME,

  -- §6.8 — planned duration; implied by a range, explicit otherwise
  planned_duration_min INTEGER,

  sort_order           SMALLINT    NOT NULL DEFAULT 0,
  archived_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX item_schedules_item ON item_schedules (item_id);
CREATE INDEX item_schedules_user ON item_schedules (user_id);

-- Backfill: exactly one schedule per existing item, carrying its current values.
INSERT INTO item_schedules (
  user_id, item_id, recurrence_rule, anchor_day, timing_precision,
  timing_bucket_id, timing_start_time, timing_end_time, planned_duration_min,
  sort_order, created_at
)
SELECT
  user_id, id, recurrence_rule, anchor_day, timing_precision,
  timing_bucket_id, timing_start_time, timing_end_time, planned_duration_min,
  0, created_at
FROM items;

-- Occurrence identity gains the schedule.  Backfilled from the single schedule
-- above before being made NOT NULL.
ALTER TABLE occurrences ADD COLUMN schedule_id UUID REFERENCES item_schedules(id);

UPDATE occurrences o
   SET schedule_id = s.id
  FROM item_schedules s
 WHERE s.item_id = o.item_id;

ALTER TABLE occurrences ALTER COLUMN schedule_id SET NOT NULL;

-- One occurrence per item per day PER SCHEDULE (was: per item per day).
ALTER TABLE occurrences DROP CONSTRAINT occurrences_item_id_applies_to_day_key;
ALTER TABLE occurrences
  ADD CONSTRAINT occurrences_item_day_schedule_key
  UNIQUE (item_id, applies_to_day, schedule_id);

CREATE INDEX occurrences_schedule_id ON occurrences (schedule_id);

-- Clean cut: these now live on item_schedules only.
ALTER TABLE items
  DROP COLUMN recurrence_rule,
  DROP COLUMN anchor_day,
  DROP COLUMN timing_precision,
  DROP COLUMN timing_bucket_id,
  DROP COLUMN timing_start_time,
  DROP COLUMN timing_end_time,
  DROP COLUMN planned_duration_min;
`

// Rolling back collapses each item's schedules back to one set of columns, taking
// the lowest-sorted active schedule (which is the only one that exists for any item
// created before this migration).  Slots beyond the first cannot survive a
// rollback — there is nowhere to put them — so a down-migration after real
// multi-schedule use is lossy by construction, not by oversight.
export const down = `
ALTER TABLE items
  ADD COLUMN recurrence_rule      JSONB,
  ADD COLUMN anchor_day           DATE,
  ADD COLUMN timing_precision     TEXT NOT NULL DEFAULT 'none'
               CHECK (timing_precision IN ('none', 'bucket', 'point', 'range')),
  ADD COLUMN timing_bucket_id     UUID REFERENCES buckets(id),
  ADD COLUMN timing_start_time    TIME,
  ADD COLUMN timing_end_time      TIME,
  ADD COLUMN planned_duration_min INTEGER;

UPDATE items i SET
  recurrence_rule      = s.recurrence_rule,
  anchor_day           = s.anchor_day,
  timing_precision     = s.timing_precision,
  timing_bucket_id     = s.timing_bucket_id,
  timing_start_time    = s.timing_start_time,
  timing_end_time      = s.timing_end_time,
  planned_duration_min = s.planned_duration_min
FROM (
  SELECT DISTINCT ON (item_id) item_id, recurrence_rule, anchor_day,
         timing_precision, timing_bucket_id, timing_start_time,
         timing_end_time, planned_duration_min
    FROM item_schedules
   WHERE archived_at IS NULL
   ORDER BY item_id, sort_order, created_at
) s
WHERE s.item_id = i.id;

DROP INDEX IF EXISTS occurrences_schedule_id;
ALTER TABLE occurrences DROP CONSTRAINT IF EXISTS occurrences_item_day_schedule_key;

-- Duplicate slots on the same day cannot coexist under the old constraint; keep the
-- earliest-materialized one so the restore is deterministic rather than failing.
DELETE FROM occurrences o
 WHERE EXISTS (
   SELECT 1 FROM occurrences k
    WHERE k.item_id = o.item_id
      AND k.applies_to_day = o.applies_to_day
      AND (k.materialized_at, k.id) < (o.materialized_at, o.id)
 );

ALTER TABLE occurrences
  ADD CONSTRAINT occurrences_item_id_applies_to_day_key
  UNIQUE (item_id, applies_to_day);

ALTER TABLE occurrences DROP COLUMN IF EXISTS schedule_id;

DROP INDEX IF EXISTS item_schedules_user;
DROP INDEX IF EXISTS item_schedules_item;
DROP TABLE IF EXISTS item_schedules CASCADE;
`

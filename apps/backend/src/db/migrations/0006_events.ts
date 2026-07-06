// §3.3 / §10 — The core event log.  The source of truth for all current state.
//
// Common fields are real indexed columns (fast filtering by day, occurrence, type).
// Type-varying payload lives in JSONB — the TypeScript layer enforces the shape via
// the TrackerEvent discriminated union in @tracker/shared.
//
// occurrence_id is nullable: template-level and config-level events have no occurrence.
// item_id is nullable: config events (categories, day-start, etc.) have no item.

export const name = '0006_events'

export const up = `
CREATE TABLE events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id),
  event_type      TEXT        NOT NULL,

  -- §10.1 — both timestamps are always recorded
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applies_to_day  DATE,

  -- nullable: some events are template- or config-level
  occurrence_id   UUID        REFERENCES occurrences(id),
  item_id         UUID        REFERENCES items(id),

  payload         JSONB       NOT NULL DEFAULT '{}'
);

-- Primary query patterns: by user+day (today's view), by occurrence, by item history
CREATE INDEX events_user_day      ON events (user_id, applies_to_day);
CREATE INDEX events_occurrence_id ON events (occurrence_id);
CREATE INDEX events_item_id       ON events (item_id);
CREATE INDEX events_event_type    ON events (event_type);
CREATE INDEX events_recorded_at   ON events (recorded_at);
`

export const down = `
DROP INDEX IF EXISTS events_recorded_at;
DROP INDEX IF EXISTS events_event_type;
DROP INDEX IF EXISTS events_item_id;
DROP INDEX IF EXISTS events_occurrence_id;
DROP INDEX IF EXISTS events_user_day;
DROP TABLE IF EXISTS events CASCADE;
`

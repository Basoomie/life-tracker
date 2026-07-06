// §3.2 / §5.4 — Occurrences are materialized lazily (not pre-generated).  A row
// only exists once the occurrence is near-term or first touched by an event.
//
// The 'snapshot' JSONB column stores a frozen copy of the item's mutable fields at
// the moment of materialization (§5.3).  Even if the template is later edited, this
// occurrence's snapshot is unchanged — history stays truthful.

export const name = '0005_occurrences'

export const up = `
CREATE TABLE occurrences (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id),
  item_id         UUID        NOT NULL REFERENCES items(id),
  applies_to_day  DATE        NOT NULL,
  snapshot        JSONB       NOT NULL,
  materialized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One occurrence per item per day
  UNIQUE (item_id, applies_to_day)
);

CREATE INDEX occurrences_user_day ON occurrences (user_id, applies_to_day);
CREATE INDEX occurrences_item_id  ON occurrences (item_id);
`

export const down = `
DROP INDEX  IF EXISTS occurrences_item_id;
DROP INDEX  IF EXISTS occurrences_user_day;
DROP TABLE  IF EXISTS occurrences CASCADE;
`

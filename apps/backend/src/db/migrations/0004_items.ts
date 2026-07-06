// §3.1 — Item (template): the central noun.  One-time task = no recurrence_rule;
// habit = has recurrence_rule.
//
// §4.1 — parent_id for the containment tree (self-referential FK).
// §4.2 — item_prerequisites junction table for task-to-task blocking edges.
//         Stored separately (not as an array) for FK integrity.
//         Cycle detection is domain logic (step 2), not a DB constraint.

export const name = '0004_items'

export const up = `
CREATE TABLE items (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID        NOT NULL REFERENCES users(id),
  name                 TEXT        NOT NULL,
  description          TEXT,
  category_id          UUID        REFERENCES categories(id),
  valence              TEXT        CHECK (valence IN ('productive', 'unproductive', 'neutral')),
  priority             TEXT        CHECK (priority IN ('high', 'medium', 'low')),

  -- §5.1 — recurrence rule; NULL = one-time task; JSONB for flexible rule shapes
  recurrence_rule      JSONB,

  -- §5.2 — stats-only quota target; does not drive scheduling
  quota_target         JSONB,

  -- §6.5 — timing at one of four precision levels; the three time columns are mutually
  --         conditional: bucket precision uses timing_bucket_id, point uses start_time,
  --         range uses both (enforcement is domain logic, not DB constraints)
  timing_precision     TEXT        NOT NULL DEFAULT 'none'
                         CHECK (timing_precision IN ('none', 'bucket', 'point', 'range')),
  timing_bucket_id     UUID        REFERENCES buckets(id),
  timing_start_time    TIME,
  timing_end_time      TIME,

  -- §6.8 — planned duration; implied by range when both ends known, explicit otherwise
  planned_duration_min INTEGER,

  -- §4.1 — containment parent; NULL = top-level item
  parent_id            UUID        REFERENCES items(id),

  -- §8.1 — end-of-day handling policy
  disposition_policy   TEXT        NOT NULL DEFAULT 'skip'
                         CHECK (disposition_policy IN ('skip', 'excuse', 'auto_close')),

  -- §9.2 — planned vs ad-hoc creation mode
  creation_source      TEXT        NOT NULL DEFAULT 'planned'
                         CHECK (creation_source IN ('planned', 'ad_hoc')),

  archived_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- §4.2 — prerequisite graph edges; task-to-task only
CREATE TABLE item_prerequisites (
  item_id         UUID        NOT NULL REFERENCES items(id),
  prerequisite_id UUID        NOT NULL REFERENCES items(id),
  user_id         UUID        NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (item_id, prerequisite_id)
);
`

export const down = `
DROP TABLE IF EXISTS item_prerequisites CASCADE;
DROP TABLE IF EXISTS items              CASCADE;
`

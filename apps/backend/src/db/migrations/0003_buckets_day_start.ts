// §6.6 — Buckets: user-defined parts of day with editable clock boundaries.
// §6.7 — Day-start timeline: each row is one configuration entry (append-only).
//         end_time < start_time means the bucket wraps past midnight; domain logic (step 2)
//         resolves this using the active day-start value.

export const name = '0003_buckets_day_start'

export const up = `
CREATE TABLE buckets (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID         NOT NULL REFERENCES users(id),
  name        TEXT         NOT NULL,
  start_time  TIME         NOT NULL,
  end_time    TIME         NOT NULL,
  sort_order  SMALLINT     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Timeline of day-start values.  'starts_on' is the first day the new value is
-- active; to find the day-start for any past day, select MAX(starts_on) <= that day.
CREATE TABLE day_start_timeline (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id),
  starts_on   DATE        NOT NULL,
  value       TIME        NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`

export const down = `
DROP TABLE IF EXISTS day_start_timeline CASCADE;
DROP TABLE IF EXISTS buckets            CASCADE;
`

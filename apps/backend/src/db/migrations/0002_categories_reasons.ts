// §3.4 / §7 — configurable lists referenced (not hardcoded) by items and events.
// Soft-deleted via archived_at so historical events that reference them never dangle.

export const name = '0002_categories_reasons'

export const up = `
CREATE TABLE categories (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id),
  name        TEXT        NOT NULL,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE reasons (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id),
  name        TEXT        NOT NULL,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`

export const down = `
DROP TABLE IF EXISTS reasons   CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
`

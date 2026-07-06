// §13.4 — minimal user table; v1 is single-user but every entity carries user_id
// from day one so adding a second account later is 'create row + let them log in',
// not a schema migration.

export const name = '0001_users'

export const up = `
CREATE TABLE users (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT        NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`

export const down = `
DROP TABLE IF EXISTS users CASCADE;
`

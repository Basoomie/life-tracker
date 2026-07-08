// §13.1 — Auth: password hash on users table; server-side session store.
// password_hash is nullable to allow safe migration of existing rows.
// Bootstrap (src/db/bootstrap.ts) always sets it; auth code rejects null hashes.

export const name = '0009_auth'

export const up = `
ALTER TABLE users ADD COLUMN password_hash TEXT;

CREATE TABLE auth_sessions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  invalidated_at TIMESTAMPTZ
);

CREATE INDEX auth_sessions_user_id_idx    ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expires_at_idx ON auth_sessions(expires_at);
`

export const down = `
DROP TABLE IF EXISTS auth_sessions;
ALTER TABLE users DROP COLUMN IF EXISTS password_hash;
`

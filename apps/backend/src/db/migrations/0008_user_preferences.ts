// §13.4 — per-user key-value preferences; used by the frontend to persist settings
// (theme, imminent window, etc.) server-side so they survive browser data clears.

export const name = '0008_user_preferences'

export const up = `
CREATE TABLE user_preferences (
  user_id    UUID        NOT NULL REFERENCES users(id),
  key        TEXT        NOT NULL,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);
`

export const down = `
DROP TABLE IF EXISTS user_preferences;
`

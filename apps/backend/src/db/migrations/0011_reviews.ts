// v2 §6 / §9.2 / §9.5.2 — The AI Review (step 3b): stored, immutable review history.
//
// A review is never edited once generated (§CLAUDE.md: derived artifacts are appended,
// not mutated in place) — there is no UPDATE path in db/repos/reviews.ts, only INSERT and
// reads. The UNIQUE constraint prevents the scheduler from double-generating the same
// cadence/period pair if the background job runs twice for the same logical day.

export const name = '0011_reviews'

export const up = `
CREATE TABLE reviews (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES users(id),

  cadence            TEXT        NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'quarterly')),
  period_start       DATE        NOT NULL,
  period_end         DATE        NOT NULL,

  generated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- §9.2: LLM synthesis, gated only on the input side (the Layer Rule) — see review/prompt-builder.ts.
  narrative          TEXT        NOT NULL,
  -- §9.4 item 3: structured Recommendation[] (verified — see review/verification.ts).
  recommendations    JSONB       NOT NULL DEFAULT '[]',
  -- §9.2.1: this review's contribution to the NEXT review's feed-forward input.
  feed_forward_out   JSONB       NOT NULL DEFAULT '[]',
  -- §9.4 item 5: rendered from the verified structure above — see review/render.ts.
  prose              TEXT        NOT NULL,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, cadence, period_start, period_end)
);

CREATE INDEX reviews_user_cadence_idx ON reviews (user_id, cadence, period_start DESC);
`

export const down = `
DROP TABLE IF EXISTS reviews CASCADE;
`

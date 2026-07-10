// v2 §9.4 / §9.4.1 — Evidence base: vetted findings that Layer 3 (not built until step 3b)
// is permitted to cite. Same soft-delete/referenced-not-hardcoded discipline as
// categories/reasons (§CLAUDE.md, §3.4): never hard-deleted, so a recommendation in a
// past review can always resolve its source.
//
// Two independent status columns, matching the generate → verify → approve pipeline (§9.4.1):
//   verification_status — set ONLY by code (the fraud detector); never by a human action.
//   approval_status     — set ONLY by a human, and only reachable once verification_status = 'verified'.
// An entry is usable (citable) iff verification_status = 'verified' AND approval_status = 'approved'
// AND archived_at IS NULL. Every other combination is inert (apps/backend/src/evidence/pipeline.ts).

export const name = '0010_evidence_base'

export const up = `
CREATE TABLE evidence_entries (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID        NOT NULL REFERENCES users(id),

  -- ── What was proposed (§9.4 item 3 — structured, not prose) ─────────────────
  claim                  TEXT        NOT NULL,
  mechanism              TEXT        NOT NULL,
  source_identifier_type TEXT        NOT NULL CHECK (source_identifier_type IN ('pmid', 'doi')),
  source_identifier      TEXT        NOT NULL,
  claimed_evidence_quality TEXT      NOT NULL
                           CHECK (claimed_evidence_quality IN
                             ('meta_analysis', 'systematic_review', 'rct', 'observational', 'mechanistic_plausibility_only')),
  grounded_justification TEXT        NOT NULL,

  provenance             TEXT        NOT NULL CHECK (provenance IN ('seeded', 'ai_proposed')),
  proposed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ── Verification result (code only; §9.4 item 4) ─────────────────────────────
  verification_status    TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  verified_at            TIMESTAMPTZ,
  rejection_reason       TEXT        CHECK (rejection_reason IN
                           ('malformed_identifier', 'identifier_not_found', 'evidence_quality_mismatch', 'network_error')),
  rejection_detail       TEXT,
  resolved_pmid          TEXT,
  resolved_title         TEXT,
  resolved_journal       TEXT,
  resolved_year          INTEGER,
  resolved_publication_types TEXT[],
  -- §9.4.2 — what makes "does the claim match the source?" answerable by the human
  -- reviewer without leaving the app. Best-effort (null when PubMed has none, or the
  -- efetch call fails); its absence must stay visible to the reviewer, never silently
  -- treated as "nothing to check" (see EvidenceApprovalView).
  resolved_abstract      TEXT,
  actual_evidence_quality TEXT       CHECK (actual_evidence_quality IN
                           ('meta_analysis', 'systematic_review', 'rct', 'observational', 'mechanistic_plausibility_only')),

  -- ── Approval decision (human only; §9.4.1 step 3) ────────────────────────────
  approval_status        TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  approved_at            TIMESTAMPTZ,
  -- §9.4.1 follow-up — DIAGNOSTIC ONLY, NEVER A GATE. Whether the abstract's <details>
  -- panel was open in the approval UI at the moment Approve was clicked; 'no_abstract'
  -- when none was ever resolved. Records visibility, not reading — do not read more into
  -- it than that. Set once, at approval time, from the same event as approval_status;
  -- untouched by rejection. Purpose is purely retrospective: if a bad entry surfaces
  -- months later, this says whether the abstract was at least in view when it was let in.
  abstract_visible_at_approval TEXT   CHECK (abstract_visible_at_approval IN ('visible', 'hidden', 'no_abstract')),

  archived_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX evidence_entries_user_id_idx     ON evidence_entries(user_id);
CREATE INDEX evidence_entries_usable_idx      ON evidence_entries(user_id, verification_status, approval_status)
  WHERE archived_at IS NULL;
`

export const down = `
DROP TABLE IF EXISTS evidence_entries CASCADE;
`

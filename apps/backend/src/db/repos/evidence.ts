// v2 §9.4 / §9.4.1 — Evidence base repo.
// Soft-deleted only (never hard-deleted, per §CLAUDE.md and §9.4.1 — a past review's
// citation must always resolve). Same pattern as categories.ts / reasons.ts.

import type { Pool } from 'pg'
import type {
  EvidenceEntry,
  EvidenceCandidate,
  EvidenceProvenance,
  ApprovalStatus,
  AbstractVisibilityAtApproval,
} from '@tracker/shared'
import type { VerificationResult } from '../../evidence/verify'

interface EvidenceEntryRow {
  id: string
  user_id: string
  claim: string
  mechanism: string
  source_identifier_type: 'pmid' | 'doi'
  source_identifier: string
  claimed_evidence_quality: string
  grounded_justification: string
  provenance: string
  proposed_at: Date
  verification_status: string
  verified_at: Date | null
  rejection_reason: string | null
  rejection_detail: string | null
  resolved_pmid: string | null
  resolved_title: string | null
  resolved_journal: string | null
  resolved_year: number | null
  resolved_publication_types: string[] | null
  resolved_abstract: string | null
  actual_evidence_quality: string | null
  approval_status: string
  approved_at: Date | null
  abstract_visible_at_approval: string | null
  archived_at: Date | null
  created_at: Date
}

function toEvidenceEntry(row: EvidenceEntryRow): EvidenceEntry {
  return {
    id: row.id,
    userId: row.user_id,
    claim: row.claim,
    mechanism: row.mechanism,
    sourceIdentifierType: row.source_identifier_type,
    sourceIdentifier: row.source_identifier,
    claimedEvidenceQuality: row.claimed_evidence_quality as EvidenceEntry['claimedEvidenceQuality'],
    groundedJustification: row.grounded_justification,
    provenance: row.provenance as EvidenceProvenance,
    proposedAt: row.proposed_at,
    verificationStatus: row.verification_status as EvidenceEntry['verificationStatus'],
    verifiedAt: row.verified_at,
    rejectionReason: row.rejection_reason as EvidenceEntry['rejectionReason'],
    rejectionDetail: row.rejection_detail,
    resolvedPmid: row.resolved_pmid,
    resolvedTitle: row.resolved_title,
    resolvedJournal: row.resolved_journal,
    resolvedYear: row.resolved_year,
    resolvedPublicationTypes: row.resolved_publication_types,
    resolvedAbstract: row.resolved_abstract,
    actualEvidenceQuality: row.actual_evidence_quality as EvidenceEntry['actualEvidenceQuality'],
    approvalStatus: row.approval_status as ApprovalStatus,
    approvedAt: row.approved_at,
    abstractVisibleAtApproval: row.abstract_visible_at_approval as AbstractVisibilityAtApproval | null,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
  }
}

// ── Insert (the "generate" step lands here, always with verification pending) ──

export async function insertEvidenceEntry(
  pool: Pool,
  data: { userId: string; provenance: EvidenceProvenance } & EvidenceCandidate
): Promise<EvidenceEntry> {
  const { rows } = await pool.query<EvidenceEntryRow>(
    `INSERT INTO evidence_entries
       (user_id, claim, mechanism, source_identifier_type, source_identifier,
        claimed_evidence_quality, grounded_justification, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      data.userId,
      data.claim,
      data.mechanism,
      data.sourceIdentifierType,
      data.sourceIdentifier,
      data.claimedEvidenceQuality,
      data.groundedJustification,
      data.provenance,
    ]
  )
  return toEvidenceEntry(rows[0])
}

// ── Verification result (written ONLY by the verification gate; never by a human) ──

export async function applyVerificationResult(
  pool: Pool,
  id: string,
  userId: string,
  result: VerificationResult
): Promise<EvidenceEntry | null> {
  if (result.status === 'verified') {
    const { rows } = await pool.query<EvidenceEntryRow>(
      `UPDATE evidence_entries
       SET verification_status = 'verified',
           verified_at = NOW(),
           rejection_reason = NULL,
           rejection_detail = NULL,
           resolved_pmid = $3,
           resolved_title = $4,
           resolved_journal = $5,
           resolved_year = $6,
           resolved_publication_types = $7,
           resolved_abstract = $8,
           actual_evidence_quality = $9
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [
        id,
        userId,
        result.resolved.pmid,
        result.resolved.title,
        result.resolved.journal,
        result.resolved.year,
        result.resolved.publicationTypes,
        result.resolved.abstract,
        result.actualEvidenceQuality,
      ]
    )
    return rows[0] ? toEvidenceEntry(rows[0]) : null
  }

  const { rows } = await pool.query<EvidenceEntryRow>(
    `UPDATE evidence_entries
     SET verification_status = 'rejected',
         verified_at = NOW(),
         rejection_reason = $3,
         rejection_detail = $4,
         resolved_pmid = $5,
         resolved_title = $6,
         resolved_journal = $7,
         resolved_year = $8,
         resolved_publication_types = $9,
         resolved_abstract = $10,
         actual_evidence_quality = $11
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [
      id,
      userId,
      result.reason,
      result.detail,
      result.resolved?.pmid ?? null,
      result.resolved?.title ?? null,
      result.resolved?.journal ?? null,
      result.resolved?.year ?? null,
      result.resolved?.publicationTypes ?? null,
      result.resolved?.abstract ?? null,
      result.actualEvidenceQuality ?? null,
    ]
  )
  return rows[0] ? toEvidenceEntry(rows[0]) : null
}

// ── Approval decision (human only; only meaningful once verified) ──────────────
//
// abstractVisibleAtApproval is written only on 'approved' (null for 'rejected' — the
// panel-visibility question is meaningless for a rejection). Diagnostic only; never
// read by any gating logic — see AbstractVisibilityAtApproval.
export async function setApprovalStatus(
  pool: Pool,
  id: string,
  userId: string,
  status: Exclude<ApprovalStatus, 'pending'>,
  abstractVisibleAtApproval: AbstractVisibilityAtApproval | null = null
): Promise<EvidenceEntry | null> {
  const { rows } = await pool.query<EvidenceEntryRow>(
    `UPDATE evidence_entries
     SET approval_status = $3,
         approved_at = NOW(),
         abstract_visible_at_approval = $4
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [id, userId, status, abstractVisibleAtApproval]
  )
  return rows[0] ? toEvidenceEntry(rows[0]) : null
}

// ── Reads ────────────────────────────────────────────────────────────────────

// Resolves regardless of archived/verification/approval status — used for resolving
// a source cited by a past review, and as the read-after-write for every mutation above.
export async function findEvidenceEntryById(
  pool: Pool,
  id: string,
  userId: string
): Promise<EvidenceEntry | null> {
  const { rows } = await pool.query<EvidenceEntryRow>(
    `SELECT * FROM evidence_entries WHERE id = $1 AND user_id = $2`,
    [id, userId]
  )
  return rows[0] ? toEvidenceEntry(rows[0]) : null
}

// Verified but not yet approved, not archived — the approval queue (§9.4.1 step 3).
export async function findPendingApproval(pool: Pool, userId: string): Promise<EvidenceEntry[]> {
  const { rows } = await pool.query<EvidenceEntryRow>(
    `SELECT * FROM evidence_entries
     WHERE user_id = $1 AND verification_status = 'verified' AND approval_status = 'pending'
       AND archived_at IS NULL
     ORDER BY proposed_at`,
    [userId]
  )
  return rows.map(toEvidenceEntry)
}

// The only query a future citation/narration layer (step 3b) is allowed to read from.
export async function findUsableEvidenceEntries(pool: Pool, userId: string): Promise<EvidenceEntry[]> {
  const { rows } = await pool.query<EvidenceEntryRow>(
    `SELECT * FROM evidence_entries
     WHERE user_id = $1 AND verification_status = 'verified' AND approval_status = 'approved'
       AND archived_at IS NULL
     ORDER BY proposed_at`,
    [userId]
  )
  return rows.map(toEvidenceEntry)
}

export async function findAllEvidenceEntries(pool: Pool, userId: string): Promise<EvidenceEntry[]> {
  const { rows } = await pool.query<EvidenceEntryRow>(
    `SELECT * FROM evidence_entries WHERE user_id = $1 ORDER BY proposed_at`,
    [userId]
  )
  return rows.map(toEvidenceEntry)
}

export async function archiveEvidenceEntry(
  pool: Pool,
  id: string,
  userId: string
): Promise<EvidenceEntry | null> {
  const { rows } = await pool.query<EvidenceEntryRow>(
    `UPDATE evidence_entries
     SET archived_at = NOW()
     WHERE id = $1 AND user_id = $2 AND archived_at IS NULL
     RETURNING *`,
    [id, userId]
  )
  return rows[0] ? toEvidenceEntry(rows[0]) : null
}

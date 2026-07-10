// v2 §9.4.1 — generate → verify → approve pipeline, DB-integration level.
// Named after the spec rules they verify (§CLAUDE.md).
//
// The external API is mocked throughout (deterministic, per CLAUDE.md's anti-flake rule) —
// these tests exercise the DB orchestration and status-transition rules, not PubMed itself
// (that's verify.test.ts's job).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from '../helpers/test-db'
import * as repos from '../../db/repos/index'
import {
  proposeEvidenceEntry,
  approveEvidenceEntry,
  rejectEvidenceEntry,
  archiveEvidenceEntryWithEvent,
} from '../../evidence/pipeline'
import type { EvidenceCandidate } from '@tracker/shared'
import type { PubmedClientDeps } from '../../evidence/pubmed-client'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

async function makeUser(email: string) {
  return repos.insertUser(getTestPool(), { email })
}

function candidate(overrides: Partial<EvidenceCandidate> = {}): EvidenceCandidate {
  return {
    claim: 'Test claim',
    mechanism: 'Test mechanism',
    sourceIdentifierType: 'pmid',
    sourceIdentifier: '23211256',
    claimedEvidenceQuality: 'mechanistic_plausibility_only',
    groundedJustification: 'Test justification',
    ...overrides,
  }
}

function verifiableDeps(pubtype: string[] = ['Journal Article']): PubmedClientDeps {
  return {
    fetchImpl: vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes('esummary.fcgi')) {
        return new Response(
          JSON.stringify({
            result: {
              uids: ['23211256'],
              '23211256': {
                uid: '23211256',
                title: 'Making health habitual',
                fulljournalname: 'Br J Gen Pract',
                pubdate: '2012 Dec',
                pubtype,
              },
            },
          }),
          { status: 200 }
        )
      }
      if (url.includes('efetch.fcgi')) {
        return new Response(
          '<PubmedArticleSet><PubmedArticle><Abstract>' +
            '<AbstractText Label="RESULTS">Test abstract text for the human review step.</AbstractText>' +
            '</Abstract></PubmedArticle></PubmedArticleSet>',
          { status: 200 }
        )
      }
      return new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 })
    }) as unknown as typeof fetch,
  }
}

function unverifiableDeps(): PubmedClientDeps {
  return {
    fetchImpl: vi.fn(async (): Promise<Response> => {
      return new Response(JSON.stringify({ result: { uids: [] } }), { status: 200 })
    }) as unknown as typeof fetch,
  }
}

// Verifies successfully but the abstract fetch yields nothing (no AbstractText tags) —
// exercises the genuine "no_abstract" case (as opposed to "abstract existed but panel
// was collapsed").
function verifiableDepsNoAbstract(): PubmedClientDeps {
  return {
    fetchImpl: vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes('esummary.fcgi')) {
        return new Response(
          JSON.stringify({
            result: {
              uids: ['23211256'],
              '23211256': {
                uid: '23211256', title: 'X', fulljournalname: 'Y', pubdate: '2012 Dec',
                pubtype: ['Journal Article'],
              },
            },
          }),
          { status: 200 }
        )
      }
      if (url.includes('efetch.fcgi')) {
        return new Response('<PubmedArticleSet></PubmedArticleSet>', { status: 200 })
      }
      return new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 })
    }) as unknown as typeof fetch,
  }
}

// ── Happy path: propose (verified) → pending approval → approve → usable ─────────

describe('§9.4.1 generate → verify → approve — full happy path', () => {
  it('a verified entry appears in the pending-approval queue, not yet in usable evidence', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-happy@test.com')

    const entry = await proposeEvidenceEntry(pool, u.id, candidate(), 'ai_proposed', verifiableDeps())
    expect(entry.verificationStatus).toBe('verified')
    expect(entry.approvalStatus).toBe('pending')

    const pending = await repos.findPendingApproval(pool, u.id)
    expect(pending.map((e) => e.id)).toContain(entry.id)

    const usableBeforeApproval = await repos.findUsableEvidenceEntries(pool, u.id)
    expect(usableBeforeApproval.map((e) => e.id)).not.toContain(entry.id)
  })

  it('§9.4.2 — the pending-approval queue carries the fetched abstract, not just title/journal/year', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-abstract@test.com')

    await proposeEvidenceEntry(pool, u.id, candidate(), 'ai_proposed', verifiableDeps())

    const pending = await repos.findPendingApproval(pool, u.id)
    expect(pending[0].resolvedAbstract).toContain('Test abstract text for the human review step')
  })

  it('approving a verified entry moves it into usable evidence and out of the pending queue', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-approve@test.com')

    const entry = await proposeEvidenceEntry(pool, u.id, candidate(), 'ai_proposed', verifiableDeps())
    const approved = await approveEvidenceEntry(pool, u.id, entry.id, true)
    expect(approved.approvalStatus).toBe('approved')
    expect(approved.approvedAt).toBeInstanceOf(Date)

    const usable = await repos.findUsableEvidenceEntries(pool, u.id)
    expect(usable.map((e) => e.id)).toContain(entry.id)

    const pending = await repos.findPendingApproval(pool, u.id)
    expect(pending.map((e) => e.id)).not.toContain(entry.id)
  })
})

// ── Unverifiable entries are never approvable, never surfaced, never usable ──────

describe('§9.4.1 — unverifiable entries never reach the user as evidence', () => {
  it('a rejected (unverifiable) entry never appears in the pending-approval queue', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-unverifiable-pending@test.com')

    const entry = await proposeEvidenceEntry(pool, u.id, candidate(), 'ai_proposed', unverifiableDeps())
    expect(entry.verificationStatus).toBe('rejected')

    const pending = await repos.findPendingApproval(pool, u.id)
    expect(pending.map((e) => e.id)).not.toContain(entry.id)
  })

  it('a rejected entry cannot be approved — no bypass around verification', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-unverifiable-approve@test.com')

    const entry = await proposeEvidenceEntry(pool, u.id, candidate(), 'ai_proposed', unverifiableDeps())
    await expect(approveEvidenceEntry(pool, u.id, entry.id, false)).rejects.toThrow(/verification_status/)

    const usable = await repos.findUsableEvidenceEntries(pool, u.id)
    expect(usable.map((e) => e.id)).not.toContain(entry.id)
  })

  it('a rejected entry cannot be retrieved through any usable-evidence path, ever', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-unverifiable-usable@test.com')

    await proposeEvidenceEntry(pool, u.id, candidate({ claim: 'Rejected claim A' }), 'ai_proposed', unverifiableDeps())
    await proposeEvidenceEntry(pool, u.id, candidate({ claim: 'Verified claim B' }), 'ai_proposed', verifiableDeps())

    const usable = await repos.findUsableEvidenceEntries(pool, u.id)
    // Verified-but-unapproved is also absent (see next describe block) — the point here
    // is specifically that the rejected one never shows up regardless of approval state.
    expect(usable.some((e) => e.claim === 'Rejected claim A')).toBe(false)
  })
})

// ── Verified-but-unapproved entries are inert ────────────────────────────────────

describe('§9.4.1 — verified-but-unapproved entries are inert', () => {
  it('a verified entry that has not been approved is absent from usable evidence', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-inert@test.com')

    const entry = await proposeEvidenceEntry(pool, u.id, candidate(), 'ai_proposed', verifiableDeps())
    expect(entry.verificationStatus).toBe('verified')
    expect(entry.approvalStatus).toBe('pending')

    const usable = await repos.findUsableEvidenceEntries(pool, u.id)
    expect(usable.map((e) => e.id)).not.toContain(entry.id)
  })
})

// ── Human rejection (relevance/fairness) ─────────────────────────────────────────

describe('§9.4.1 step 3 — human approval/rejection', () => {
  it('a human can reject a verified entry; it becomes permanently absent from usable evidence', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-human-reject@test.com')

    const entry = await proposeEvidenceEntry(pool, u.id, candidate(), 'ai_proposed', verifiableDeps())
    const rejected = await rejectEvidenceEntry(pool, u.id, entry.id)
    expect(rejected.approvalStatus).toBe('rejected')

    const usable = await repos.findUsableEvidenceEntries(pool, u.id)
    expect(usable.map((e) => e.id)).not.toContain(entry.id)
    const pending = await repos.findPendingApproval(pool, u.id)
    expect(pending.map((e) => e.id)).not.toContain(entry.id)
  })

  it('a human cannot reject an entry that has not passed verification', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-human-reject-unverified@test.com')

    const entry = await proposeEvidenceEntry(pool, u.id, candidate(), 'ai_proposed', unverifiableDeps())
    await expect(rejectEvidenceEntry(pool, u.id, entry.id)).rejects.toThrow(/verification_status/)
  })
})

// ── Rejection reasons are recorded and explicable ────────────────────────────────

describe('§9.4 — verification failures are explicable', () => {
  it('records a machine-readable reason and a human-readable detail on rejection', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-explicable@test.com')

    const entry = await proposeEvidenceEntry(pool, u.id, candidate(), 'ai_proposed', unverifiableDeps())
    expect(entry.rejectionReason).toBe('identifier_not_found')
    expect(entry.rejectionDetail).toBeTruthy()
    expect(entry.rejectionDetail).toContain('23211256')
  })
})

// ── No bypass ─────────────────────────────────────────────────────────────────────

describe('§9.4.1 — no privileged bypass exists for any provenance, including seeded', () => {
  it('a seeded candidate goes through identical verify → approve gating as an ai_proposed one', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-seeded@test.com')

    const seeded = await proposeEvidenceEntry(pool, u.id, candidate({ claim: 'Seeded claim' }), 'seeded', unverifiableDeps())
    expect(seeded.verificationStatus).toBe('rejected')
    expect(seeded.provenance).toBe('seeded')
    await expect(approveEvidenceEntry(pool, u.id, seeded.id, false)).rejects.toThrow(/verification_status/)
  })

  it('inserting a row directly via the repo (bypassing proposeEvidenceEntry) leaves it pending, never verified — demonstrating verification only happens through the pipeline', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-direct-insert@test.com')

    const raw = await repos.insertEvidenceEntry(pool, { userId: u.id, provenance: 'ai_proposed', ...candidate() })
    expect(raw.verificationStatus).toBe('pending')

    // Not verified, so cannot be approved — proving there is no path to 'usable' that
    // skips verifyCandidate().
    await expect(approveEvidenceEntry(pool, u.id, raw.id, false)).rejects.toThrow(/verification_status/)
  })
})

// ── Soft-delete ───────────────────────────────────────────────────────────────────

describe('§CLAUDE.md / §9.4.1 — soft-delete: an archived entry still resolves for a past citation', () => {
  it('archiving an approved entry removes it from usable evidence but findEvidenceEntryById still resolves it', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-archive@test.com')

    const entry = await proposeEvidenceEntry(pool, u.id, candidate(), 'ai_proposed', verifiableDeps())
    await approveEvidenceEntry(pool, u.id, entry.id, true)

    const archived = await archiveEvidenceEntryWithEvent(pool, u.id, entry.id)
    expect(archived.archivedAt).toBeInstanceOf(Date)

    const usable = await repos.findUsableEvidenceEntries(pool, u.id)
    expect(usable.map((e) => e.id)).not.toContain(entry.id)

    // Still resolvable by id — a review that cited this entry in the past must always
    // be able to resolve its source.
    const resolved = await repos.findEvidenceEntryById(pool, entry.id, u.id)
    expect(resolved).not.toBeNull()
    expect(resolved!.claim).toBe(entry.claim)
  })
})

// ── user_id scoping ────────────────────────────────────────────────────────────

describe('§13.4 — evidence entries are strictly user_id-scoped', () => {
  it('one user cannot see, approve, or resolve another user\'s evidence entries', async () => {
    const pool = getTestPool()
    const u1 = await makeUser('pipeline-scope-1@test.com')
    const u2 = await makeUser('pipeline-scope-2@test.com')

    const entry = await proposeEvidenceEntry(pool, u1.id, candidate(), 'ai_proposed', verifiableDeps())

    const u2Pending = await repos.findPendingApproval(pool, u2.id)
    expect(u2Pending.map((e) => e.id)).not.toContain(entry.id)

    const u2Resolved = await repos.findEvidenceEntryById(pool, entry.id, u2.id)
    expect(u2Resolved).toBeNull()

    await expect(approveEvidenceEntry(pool, u2.id, entry.id, false)).rejects.toThrow(/not found/)
  })
})

// ── Event logging (§CLAUDE.md — capture everything; every mutation logs an event) ──

describe('§10 — evidence pipeline transitions are logged as events, same as category/reason mutations', () => {
  it('propose, verify, and approve each write a config-level event', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-events@test.com')

    const entry = await proposeEvidenceEntry(pool, u.id, candidate(), 'ai_proposed', verifiableDeps())
    await approveEvidenceEntry(pool, u.id, entry.id, true)

    const events = await repos.findConfigEvents(pool, u.id)
    const forEntry = events.filter((e) => (e.payload as { evidenceEntryId?: string }).evidenceEntryId === entry.id)
    const types = forEntry.map((e) => e.eventType)

    expect(types).toContain('evidence_entry_proposed')
    expect(types).toContain('evidence_entry_verified')
    expect(types).toContain('evidence_entry_approved')

    const approvedEvent = forEntry.find((e) => e.eventType === 'evidence_entry_approved')
    expect((approvedEvent!.payload as { abstractVisibleAtApproval?: string }).abstractVisibleAtApproval).toBe('visible')
  })

  it('a verification rejection is logged distinctly from a human approval rejection', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-events-reject@test.com')

    const verifiedThenHumanRejected = await proposeEvidenceEntry(pool, u.id, candidate({ claim: 'A' }), 'ai_proposed', verifiableDeps())
    await rejectEvidenceEntry(pool, u.id, verifiedThenHumanRejected.id)

    const failedVerification = await proposeEvidenceEntry(pool, u.id, candidate({ claim: 'B' }), 'ai_proposed', unverifiableDeps())

    const events = await repos.findConfigEvents(pool, u.id)
    const typesFor = (id: string) =>
      events.filter((e) => (e.payload as { evidenceEntryId?: string }).evidenceEntryId === id).map((e) => e.eventType)

    expect(typesFor(verifiedThenHumanRejected.id)).toContain('evidence_entry_approval_rejected')
    expect(typesFor(failedVerification.id)).toContain('evidence_entry_verification_rejected')
    expect(typesFor(failedVerification.id)).not.toContain('evidence_entry_approval_rejected')
  })
})

// ── §9.4.1 follow-up — abstract-visible diagnostic: recorded, never a gate ───────
//
// "A gate that can be satisfied without doing the thing it gates is worse than no
// gate." abstractVisibleAtApproval is retrospective diagnosis, not enforcement — these
// tests assert BOTH halves: the value is recorded faithfully, AND approval never fails
// or changes behavior because of it. The absence of a gate is itself the behavior
// under test, in the last two cases below.

describe('§9.4.1 follow-up — abstract-visible diagnostic reflects reality, and never gates', () => {
  it('records "visible" when the caller reports the panel was open at approval', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-abstract-visible@test.com')

    const entry = await proposeEvidenceEntry(pool, u.id, candidate(), 'ai_proposed', verifiableDeps())
    const approved = await approveEvidenceEntry(pool, u.id, entry.id, true)
    expect(approved.abstractVisibleAtApproval).toBe('visible')
  })

  it('records "hidden" when the caller reports the panel was collapsed at approval — and approval still succeeds', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-abstract-hidden@test.com')

    const entry = await proposeEvidenceEntry(pool, u.id, candidate(), 'ai_proposed', verifiableDeps())
    const approved = await approveEvidenceEntry(pool, u.id, entry.id, false)
    expect(approved.approvalStatus).toBe('approved')   // NOT blocked
    expect(approved.abstractVisibleAtApproval).toBe('hidden')
  })

  it('records "no_abstract" when none was ever resolved, regardless of what the caller reports — the server is authoritative, never the client', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-abstract-none@test.com')

    const entry = await proposeEvidenceEntry(pool, u.id, candidate(), 'ai_proposed', verifiableDepsNoAbstract())
    expect(entry.resolvedAbstract).toBeNull()

    // Caller (mis)reports true — the server must not trust it, since no panel could
    // possibly have existed for an abstract that was never fetched.
    const approved = await approveEvidenceEntry(pool, u.id, entry.id, true)
    expect(approved.approvalStatus).toBe('approved')   // NOT blocked
    expect(approved.abstractVisibleAtApproval).toBe('no_abstract')
  })

  it('a rejection never sets abstractVisibleAtApproval — the question is meaningless for a rejection', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-abstract-reject@test.com')

    const entry = await proposeEvidenceEntry(pool, u.id, candidate(), 'ai_proposed', verifiableDeps())
    const rejected = await rejectEvidenceEntry(pool, u.id, entry.id)
    expect(rejected.abstractVisibleAtApproval).toBeNull()
  })

  it('approval succeeds with the panel collapsed AND with no abstract present — no state blocks Approve', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-abstract-never-blocks@test.com')

    const collapsed = await proposeEvidenceEntry(pool, u.id, candidate({ claim: 'Collapsed' }), 'ai_proposed', verifiableDeps())
    const noAbstract = await proposeEvidenceEntry(pool, u.id, candidate({ claim: 'No abstract' }), 'ai_proposed', verifiableDepsNoAbstract())

    await expect(approveEvidenceEntry(pool, u.id, collapsed.id, false)).resolves.toMatchObject({ approvalStatus: 'approved' })
    await expect(approveEvidenceEntry(pool, u.id, noAbstract.id, false)).resolves.toMatchObject({ approvalStatus: 'approved' })
  })
})

// ── Determinism ────────────────────────────────────────────────────────────────

describe('§9.4 / §CLAUDE.md — verification is deterministic (mocked network, zero flakes)', () => {
  it('proposing the same candidate twice with the same mocked responses yields the same verification outcome', async () => {
    const pool = getTestPool()
    const u = await makeUser('pipeline-determinism@test.com')

    const e1 = await proposeEvidenceEntry(pool, u.id, candidate({ claim: 'Determinism A' }), 'ai_proposed', verifiableDeps())
    const e2 = await proposeEvidenceEntry(pool, u.id, candidate({ claim: 'Determinism B' }), 'ai_proposed', verifiableDeps())
    expect(e1.verificationStatus).toBe('verified')
    expect(e2.verificationStatus).toBe('verified')
  })
})

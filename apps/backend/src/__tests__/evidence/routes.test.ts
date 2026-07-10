// v2 §9.4.1 "Approval UI (minimal)" — API layer for the evidence approval surface.
// Named after the spec rules they verify.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from '../helpers/test-db'
import * as repos from '../../db/repos/index'
import { buildApp } from '../../app'
import { proposeEvidenceEntry } from '../../evidence/pipeline'
import type { EvidenceCandidate } from '@tracker/shared'
import type { PubmedClientDeps } from '../../evidence/pubmed-client'
import type { FastifyInstance } from 'fastify'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

async function makeUser(email: string) {
  return repos.insertUser(getTestPool(), { email })
}

async function buildTestApp(userId: string): Promise<FastifyInstance> {
  return buildApp(async () => userId)
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

function verifiableDeps(): PubmedClientDeps {
  return {
    fetchImpl: vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes('efetch.fcgi')) {
        return new Response(
          '<PubmedArticleSet><PubmedArticle><Abstract>' +
            '<AbstractText Label="RESULTS">Test abstract text.</AbstractText>' +
            '</Abstract></PubmedArticle></PubmedArticleSet>',
          { status: 200 }
        )
      }
      return new Response(
        JSON.stringify({
          result: {
            uids: ['23211256'],
            '23211256': {
              uid: '23211256',
              title: 'Making health habitual',
              fulljournalname: 'Br J Gen Pract',
              pubdate: '2012 Dec',
              pubtype: ['Journal Article'],
            },
          },
        }),
        { status: 200 }
      )
    }) as unknown as typeof fetch,
  }
}

function unverifiableDeps(): PubmedClientDeps {
  return {
    fetchImpl: vi.fn(async (): Promise<Response> =>
      new Response(JSON.stringify({ result: { uids: [] } }), { status: 200 })
    ) as unknown as typeof fetch,
  }
}

describe('§9.4.1 — GET /api/evidence/pending-approval lists only verified, unapproved, unarchived entries', () => {
  it('returns a verified entry awaiting approval and omits a rejected one', async () => {
    const u = await makeUser('routes-pending@test.com')
    const app = await buildTestApp(u.id)

    const verified = await proposeEvidenceEntry(getTestPool(), u.id, candidate({ claim: 'Verified one' }), 'ai_proposed', verifiableDeps())
    await proposeEvidenceEntry(getTestPool(), u.id, candidate({ claim: 'Rejected one' }), 'ai_proposed', unverifiableDeps())

    const res = await app.inject({ method: 'GET', url: '/api/evidence/pending-approval' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as Array<{ id: string; claim: string }>
    expect(body.map((e) => e.id)).toContain(verified.id)
    expect(body.some((e) => e.claim === 'Rejected one')).toBe(false)

    await app.close()
  })

  it('is user_id-scoped: one user does not see another user\'s pending entries', async () => {
    const u1 = await makeUser('routes-scope-1@test.com')
    const u2 = await makeUser('routes-scope-2@test.com')

    await proposeEvidenceEntry(getTestPool(), u1.id, candidate(), 'ai_proposed', verifiableDeps())

    const app2 = await buildTestApp(u2.id)
    const res = await app2.inject({ method: 'GET', url: '/api/evidence/pending-approval' })
    expect(JSON.parse(res.body)).toEqual([])
    await app2.close()
  })
})

describe('§9.4.1 step 3 — POST /api/evidence/:id/approve and /reject', () => {
  it('approves a verified entry and it disappears from the pending queue', async () => {
    const u = await makeUser('routes-approve@test.com')
    const app = await buildTestApp(u.id)

    const entry = await proposeEvidenceEntry(getTestPool(), u.id, candidate(), 'ai_proposed', verifiableDeps())

    const res = await app.inject({ method: 'POST', url: `/api/evidence/${entry.id}/approve` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).approvalStatus).toBe('approved')

    const pendingRes = await app.inject({ method: 'GET', url: '/api/evidence/pending-approval' })
    expect(JSON.parse(pendingRes.body).map((e: { id: string }) => e.id)).not.toContain(entry.id)

    await app.close()
  })

  it('§9.4.1 follow-up — forwards abstractVisible from the request body into the diagnostic field, but never blocks on it', async () => {
    const u = await makeUser('routes-abstract-visible@test.com')
    const app = await buildTestApp(u.id)

    const entry = await proposeEvidenceEntry(getTestPool(), u.id, candidate(), 'ai_proposed', verifiableDeps())

    const res = await app.inject({
      method: 'POST',
      url: `/api/evidence/${entry.id}/approve`,
      payload: { abstractVisible: false },
    })
    expect(res.statusCode).toBe(200)   // succeeds even though the panel was reported collapsed
    expect(JSON.parse(res.body).abstractVisibleAtApproval).toBe('hidden')

    await app.close()
  })

  it('§9.4.1 follow-up — omitting the body entirely still approves successfully (diagnostic is optional, never required)', async () => {
    const u = await makeUser('routes-abstract-omitted@test.com')
    const app = await buildTestApp(u.id)

    const entry = await proposeEvidenceEntry(getTestPool(), u.id, candidate(), 'ai_proposed', verifiableDeps())

    const res = await app.inject({ method: 'POST', url: `/api/evidence/${entry.id}/approve` })
    expect(res.statusCode).toBe(200)

    await app.close()
  })

  it('rejects a verified entry via the reject route', async () => {
    const u = await makeUser('routes-reject@test.com')
    const app = await buildTestApp(u.id)

    const entry = await proposeEvidenceEntry(getTestPool(), u.id, candidate(), 'ai_proposed', verifiableDeps())

    const res = await app.inject({ method: 'POST', url: `/api/evidence/${entry.id}/reject` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).approvalStatus).toBe('rejected')

    await app.close()
  })

  it('refuses to approve an entry that never passed verification (400, not silently accepted)', async () => {
    const u = await makeUser('routes-approve-unverified@test.com')
    const app = await buildTestApp(u.id)

    const entry = await proposeEvidenceEntry(getTestPool(), u.id, candidate(), 'ai_proposed', unverifiableDeps())

    const res = await app.inject({ method: 'POST', url: `/api/evidence/${entry.id}/approve` })
    expect(res.statusCode).toBe(400)

    await app.close()
  })

  it('returns 404 for an unknown evidence entry id', async () => {
    const u = await makeUser('routes-not-found@test.com')
    const app = await buildTestApp(u.id)

    const res = await app.inject({ method: 'POST', url: '/api/evidence/00000000-0000-0000-0000-000000000000/approve' })
    expect(res.statusCode).toBe(404)

    await app.close()
  })
})

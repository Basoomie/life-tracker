// Manual drag-and-drop child ordering — spec-named per CLAUDE.md's testing
// discipline. This feature is not covered by docs/design.md (predates it);
// tests are named after the behavior contract agreed with the user instead.
//
// All tests use app.inject() against a real Fastify instance, mirroring
// apps/backend/src/__tests__/api.test.ts's pattern.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from './helpers/test-db'
import * as repos from '../db/repos/index'
import { buildApp } from '../app'
import type { FastifyInstance } from 'fastify'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

async function makeUser(email: string) {
  return repos.insertUser(getTestPool(), { email })
}

async function buildTestApp(userId: string): Promise<FastifyInstance> {
  return buildApp(async () => userId)
}

describe('reordering children updates sort_order and findChildItems reflects the new order', () => {
  it('reordering children updates sort_order and findChildItems reflects the new order', async () => {
    const u = await makeUser('reorder-basic@test.com')
    const app = await buildTestApp(u.id)

    const parent = await repos.insertItem(getTestPool(), { userId: u.id, name: 'Morning Routine', creationSource: 'planned' })
    const a = await repos.insertItem(getTestPool(), { userId: u.id, name: 'A', parentId: parent.id, creationSource: 'planned' })
    const b = await repos.insertItem(getTestPool(), { userId: u.id, name: 'B', parentId: parent.id, creationSource: 'planned' })
    const c = await repos.insertItem(getTestPool(), { userId: u.id, name: 'C', parentId: parent.id, creationSource: 'planned' })

    // Default order is creation order: A, B, C
    const before = await repos.findChildItems(getTestPool(), parent.id, u.id)
    expect(before.map((i) => i.id)).toEqual([a.id, b.id, c.id])

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${parent.id}/reorder-children`,
      payload: { childItemIds: [c.id, a.id, b.id] },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.map((i: { id: string }) => i.id)).toEqual([c.id, a.id, b.id])

    const after = await repos.findChildItems(getTestPool(), parent.id, u.id)
    expect(after.map((i) => i.id)).toEqual([c.id, a.id, b.id])
    expect(after.find((i) => i.id === c.id)!.sortOrder).toBe(0)
    expect(after.find((i) => i.id === a.id)!.sortOrder).toBe(1)
    expect(after.find((i) => i.id === b.id)!.sortOrder).toBe(2)

    await app.close()
  })
})

describe('reorder request with a missing/extra/duplicate child id is rejected with 400', () => {
  it('rejects a missing child id', async () => {
    const u = await makeUser('reorder-missing@test.com')
    const app = await buildTestApp(u.id)
    const parent = await repos.insertItem(getTestPool(), { userId: u.id, name: 'Parent', creationSource: 'planned' })
    const a = await repos.insertItem(getTestPool(), { userId: u.id, name: 'A', parentId: parent.id, creationSource: 'planned' })
    await repos.insertItem(getTestPool(), { userId: u.id, name: 'B', parentId: parent.id, creationSource: 'planned' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${parent.id}/reorder-children`,
      payload: { childItemIds: [a.id] }, // missing B
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('rejects an extra (non-child) id', async () => {
    const u = await makeUser('reorder-extra@test.com')
    const app = await buildTestApp(u.id)
    const parent = await repos.insertItem(getTestPool(), { userId: u.id, name: 'Parent', creationSource: 'planned' })
    const a = await repos.insertItem(getTestPool(), { userId: u.id, name: 'A', parentId: parent.id, creationSource: 'planned' })
    const stranger = await repos.insertItem(getTestPool(), { userId: u.id, name: 'Not a child', creationSource: 'planned' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${parent.id}/reorder-children`,
      payload: { childItemIds: [a.id, stranger.id] },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('rejects a duplicate id', async () => {
    const u = await makeUser('reorder-dup@test.com')
    const app = await buildTestApp(u.id)
    const parent = await repos.insertItem(getTestPool(), { userId: u.id, name: 'Parent', creationSource: 'planned' })
    const a = await repos.insertItem(getTestPool(), { userId: u.id, name: 'A', parentId: parent.id, creationSource: 'planned' })
    const b = await repos.insertItem(getTestPool(), { userId: u.id, name: 'B', parentId: parent.id, creationSource: 'planned' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${parent.id}/reorder-children`,
      payload: { childItemIds: [a.id, a.id] }, // duplicate A, missing B
    })
    expect(res.statusCode).toBe(400)

    // Order untouched by the rejected request
    const after = await repos.findChildItems(getTestPool(), parent.id, u.id)
    expect(after.map((i) => i.id)).toEqual([a.id, b.id])

    await app.close()
  })
})

describe('reordering fires a children_reordered event with previous and new order', () => {
  it('reordering fires a children_reordered event with previous and new order', async () => {
    const u = await makeUser('reorder-event@test.com')
    const app = await buildTestApp(u.id)
    const parent = await repos.insertItem(getTestPool(), { userId: u.id, name: 'Parent', creationSource: 'planned' })
    const a = await repos.insertItem(getTestPool(), { userId: u.id, name: 'A', parentId: parent.id, creationSource: 'planned' })
    const b = await repos.insertItem(getTestPool(), { userId: u.id, name: 'B', parentId: parent.id, creationSource: 'planned' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${parent.id}/reorder-children`,
      payload: { childItemIds: [b.id, a.id] },
    })
    expect(res.statusCode).toBe(200)

    const events = await repos.findTemplateEventsByItem(getTestPool(), parent.id, u.id)
    const reorderEvent = events.find((e) => e.eventType === 'children_reordered')
    expect(reorderEvent).toBeDefined()
    expect(reorderEvent!.payload).toMatchObject({
      parentId: parent.id,
      previousOrder: [a.id, b.id],
      newOrder: [b.id, a.id],
    })

    await app.close()
  })
})

describe("a newly created child appends after existing siblings, not at position 0", () => {
  it("a newly created child appends after existing siblings, not at position 0", async () => {
    const u = await makeUser('reorder-append@test.com')
    const app = await buildTestApp(u.id)
    const parent = await repos.insertItem(getTestPool(), { userId: u.id, name: 'Parent', creationSource: 'planned' })

    // A and B created through the real route so each gets a proper
    // incrementing sortOrder (repos.insertItem alone always defaults to 0).
    const resA = await app.inject({ method: 'POST', url: '/api/items', payload: { name: 'A', parentId: parent.id } })
    const resB = await app.inject({ method: 'POST', url: '/api/items', payload: { name: 'B', parentId: parent.id } })
    const a = JSON.parse(resA.body)
    const b = JSON.parse(resB.body)
    expect(a.sortOrder).toBe(0)
    expect(b.sortOrder).toBe(1)

    const res = await app.inject({
      method: 'POST',
      url: '/api/items',
      payload: { name: 'C', parentId: parent.id },
    })
    expect(res.statusCode).toBe(201)
    const created = JSON.parse(res.body)
    expect(created.sortOrder).toBe(2) // after A (0) and B (1)

    const children = await repos.findChildItems(getTestPool(), parent.id, u.id)
    expect(children.map((i) => i.id)).toEqual([a.id, b.id, created.id])

    await app.close()
  })
})

describe('children with no manual order yet fall back to creation-order display', () => {
  it('children with no manual order yet fall back to creation-order display', async () => {
    const u = await makeUser('reorder-default@test.com')
    const app = await buildTestApp(u.id)
    const parent = await repos.insertItem(getTestPool(), { userId: u.id, name: 'Parent', creationSource: 'planned' })
    const a = await repos.insertItem(getTestPool(), { userId: u.id, name: 'A', parentId: parent.id, creationSource: 'planned' })
    const b = await repos.insertItem(getTestPool(), { userId: u.id, name: 'B', parentId: parent.id, creationSource: 'planned' })

    // Both tie at the migration default (sortOrder 0) — never reordered
    expect(a.sortOrder).toBe(0)
    expect(b.sortOrder).toBe(0)

    const children = await repos.findChildItems(getTestPool(), parent.id, u.id)
    expect(children.map((i) => i.id)).toEqual([a.id, b.id]) // creation-order tiebreak

    await app.close()
  })
})

// ── Root (top-level) item reordering ─────────────────────────────────────────
// Unlike children, root items are shown through filtered/tiered subsets
// (Now view's tiers, List/Calendar filters), so reorder-root can't require
// the full sibling set the way reorder-children does — it only accepts
// "put this item after that one" and recomputes the full order itself.

describe('reordering a root item via afterItemId updates sort_order for all root items', () => {
  it('splices the moved item into position and densely renumbers the rest', async () => {
    const u = await makeUser('root-reorder-basic@test.com')
    const app = await buildTestApp(u.id)

    const a = await repos.insertItem(getTestPool(), { userId: u.id, name: 'A', creationSource: 'planned' })
    const b = await repos.insertItem(getTestPool(), { userId: u.id, name: 'B', creationSource: 'planned' })
    const c = await repos.insertItem(getTestPool(), { userId: u.id, name: 'C', creationSource: 'planned' })

    // Default order is creation order: A, B, C
    const before = await repos.findRootItems(getTestPool(), u.id)
    expect(before.map((i) => i.id)).toEqual([a.id, b.id, c.id])

    // Move C to right after A: A, C, B
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${c.id}/reorder-root`,
      payload: { afterItemId: a.id },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.map((i: { id: string }) => i.id)).toEqual([a.id, c.id, b.id])

    const after = await repos.findRootItems(getTestPool(), u.id)
    expect(after.map((i) => i.id)).toEqual([a.id, c.id, b.id])
    expect(after.find((i) => i.id === a.id)!.sortOrder).toBe(0)
    expect(after.find((i) => i.id === c.id)!.sortOrder).toBe(1)
    expect(after.find((i) => i.id === b.id)!.sortOrder).toBe(2)

    await app.close()
  })

  it('afterItemId: null moves the item to the very front', async () => {
    const u = await makeUser('root-reorder-front@test.com')
    const app = await buildTestApp(u.id)

    const a = await repos.insertItem(getTestPool(), { userId: u.id, name: 'A', creationSource: 'planned' })
    const b = await repos.insertItem(getTestPool(), { userId: u.id, name: 'B', creationSource: 'planned' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${b.id}/reorder-root`,
      payload: { afterItemId: null },
    })
    expect(res.statusCode).toBe(200)

    const after = await repos.findRootItems(getTestPool(), u.id)
    expect(after.map((i) => i.id)).toEqual([b.id, a.id])

    await app.close()
  })
})

describe('reorder-root only needs a real neighbor, not the full unfiltered sibling set', () => {
  it('correctly interleaves a moved item among siblings the caller never saw', async () => {
    // Simulates a filtered/tiered client view: the caller only knows about
    // E and B (say, everything else is hidden by a category filter), but
    // dragging E to "after B" must still land it correctly relative to the
    // hidden items C and D that actually sit between B and the rest.
    const u = await makeUser('root-reorder-partial@test.com')
    const app = await buildTestApp(u.id)

    const a = await repos.insertItem(getTestPool(), { userId: u.id, name: 'A', creationSource: 'planned' })
    const b = await repos.insertItem(getTestPool(), { userId: u.id, name: 'B', creationSource: 'planned' })
    const c = await repos.insertItem(getTestPool(), { userId: u.id, name: 'C', creationSource: 'planned' })
    const d = await repos.insertItem(getTestPool(), { userId: u.id, name: 'D', creationSource: 'planned' })
    const e = await repos.insertItem(getTestPool(), { userId: u.id, name: 'E', creationSource: 'planned' })

    // Default order: A, B, C, D, E. Move E to right after B.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${e.id}/reorder-root`,
      payload: { afterItemId: b.id },
    })
    expect(res.statusCode).toBe(200)

    const after = await repos.findRootItems(getTestPool(), u.id)
    expect(after.map((i) => i.id)).toEqual([a.id, b.id, e.id, c.id, d.id])

    await app.close()
  })
})

describe('reorder-root rejects invalid targets with 400', () => {
  it('rejects reordering a child item (not a root item)', async () => {
    const u = await makeUser('root-reorder-notroot@test.com')
    const app = await buildTestApp(u.id)
    const parent = await repos.insertItem(getTestPool(), { userId: u.id, name: 'Parent', creationSource: 'planned' })
    const child = await repos.insertItem(getTestPool(), { userId: u.id, name: 'Child', parentId: parent.id, creationSource: 'planned' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${child.id}/reorder-root`,
      payload: { afterItemId: null },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('rejects afterItemId equal to the item itself', async () => {
    const u = await makeUser('root-reorder-self@test.com')
    const app = await buildTestApp(u.id)
    const a = await repos.insertItem(getTestPool(), { userId: u.id, name: 'A', creationSource: 'planned' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${a.id}/reorder-root`,
      payload: { afterItemId: a.id },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('rejects an afterItemId that is a child item, not a root item', async () => {
    const u = await makeUser('root-reorder-badneighbor@test.com')
    const app = await buildTestApp(u.id)
    const a = await repos.insertItem(getTestPool(), { userId: u.id, name: 'A', creationSource: 'planned' })
    const parent = await repos.insertItem(getTestPool(), { userId: u.id, name: 'Parent', creationSource: 'planned' })
    const child = await repos.insertItem(getTestPool(), { userId: u.id, name: 'Child', parentId: parent.id, creationSource: 'planned' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${a.id}/reorder-root`,
      payload: { afterItemId: child.id },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})

describe('reordering a root item fires a root_items_reordered event with previous and new order', () => {
  it('reordering a root item fires a root_items_reordered event with previous and new order', async () => {
    const u = await makeUser('root-reorder-event@test.com')
    const app = await buildTestApp(u.id)
    const a = await repos.insertItem(getTestPool(), { userId: u.id, name: 'A', creationSource: 'planned' })
    const b = await repos.insertItem(getTestPool(), { userId: u.id, name: 'B', creationSource: 'planned' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${b.id}/reorder-root`,
      payload: { afterItemId: null },
    })
    expect(res.statusCode).toBe(200)

    const events = await repos.findTemplateEventsByItem(getTestPool(), b.id, u.id)
    const reorderEvent = events.find((e) => e.eventType === 'root_items_reordered')
    expect(reorderEvent).toBeDefined()
    expect(reorderEvent!.payload).toMatchObject({
      itemId: b.id,
      afterItemId: null,
      previousOrder: [a.id, b.id],
      newOrder: [b.id, a.id],
    })

    await app.close()
  })
})

describe('a newly created root item appends after existing siblings, not at position 0', () => {
  it('a newly created root item appends after existing siblings, not at position 0', async () => {
    const u = await makeUser('root-reorder-append@test.com')
    const app = await buildTestApp(u.id)

    const resA = await app.inject({ method: 'POST', url: '/api/items', payload: { name: 'A' } })
    const resB = await app.inject({ method: 'POST', url: '/api/items', payload: { name: 'B' } })
    const a = JSON.parse(resA.body)
    const b = JSON.parse(resB.body)
    expect(a.sortOrder).toBe(0)
    expect(b.sortOrder).toBe(1)

    const res = await app.inject({ method: 'POST', url: '/api/items', payload: { name: 'C' } })
    expect(res.statusCode).toBe(201)
    const created = JSON.parse(res.body)
    expect(created.sortOrder).toBe(2) // after A (0) and B (1)

    const roots = await repos.findRootItems(getTestPool(), u.id)
    expect(roots.map((i) => i.id)).toEqual([a.id, b.id, created.id])

    await app.close()
  })
})

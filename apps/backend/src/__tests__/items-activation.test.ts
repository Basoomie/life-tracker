// §5.6 — Active / inactive items, through the API.
//
// Tests are named after the spec's stated rules. All use app.inject() against a real
// Fastify instance backed by the test DB; the domain rules themselves are covered in
// deactivation.test.ts, so what is asserted here is the contract a client sees:
// which endpoint, which status code, which slice of items.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from './helpers/test-db'
import * as repos from '../db/repos/index'
import { buildApp } from '../app'
import { createItem } from '../domain/items'
import type { FastifyInstance } from 'fastify'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

async function makeUser(email: string) {
  return repos.insertUser(getTestPool(), { email })
}

// An app that always resolves to the given userId (no auth logic).
async function buildTestApp(userId: string): Promise<FastifyInstance> {
  return buildApp(async () => userId)
}

async function makeDaily(userId: string, name: string, parentId?: string) {
  return createItem(getTestPool(), {
    userId, name, parentId: parentId ?? null,
    recurrenceRule: { type: 'daily' }, creationSource: 'planned',
  })
}

const idsOf = (res: { body: string }) =>
  (JSON.parse(res.body) as Array<{ id: string }>).map((i) => i.id)

// ── The endpoints ────────────────────────────────────────────────────────────

describe('§5.6 — deactivate and reactivate are their own endpoints, not a delete', () => {
  it('POST /items/:id/deactivate pauses the item and reports what it affected', async () => {
    const u = await makeUser('act-deactivate@test.com')
    const app = await buildTestApp(u.id)
    const item = await makeDaily(u.id, 'Guitar practice')

    const res = await app.inject({ method: 'POST', url: `/api/items/${item.id}/deactivate` })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.body) as {
      item: { id: string; deactivatedAt: string | null; schedules: unknown[] }
      affected: Array<{ id: string }>
    }
    expect(body.item.id).toBe(item.id)
    expect(body.item.deactivatedAt).not.toBeNull()
    expect(body.item.schedules).toHaveLength(1)      // the slot survives the pause
    expect(body.affected.map((i) => i.id)).toEqual([item.id])

    await app.close()
  })

  it('POST /items/:id/reactivate switches it back on', async () => {
    const u = await makeUser('act-reactivate@test.com')
    const app = await buildTestApp(u.id)
    const item = await makeDaily(u.id, 'Guitar practice')
    await app.inject({ method: 'POST', url: `/api/items/${item.id}/deactivate` })

    const res = await app.inject({ method: 'POST', url: `/api/items/${item.id}/reactivate` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).item.deactivatedAt).toBeNull()

    await app.close()
  })

  it('the cascade over a subtree is reported, so the user knows what else moved', async () => {
    const u = await makeUser('act-cascade-response@test.com')
    const app = await buildTestApp(u.id)
    const parent = await makeDaily(u.id, 'Morning routine')
    const child = await makeDaily(u.id, 'Stretch', parent.id)

    const res = await app.inject({ method: 'POST', url: `/api/items/${parent.id}/deactivate` })
    const body = JSON.parse(res.body) as { affected: Array<{ id: string }> }
    expect(body.affected.map((i) => i.id)).toEqual([parent.id, child.id])

    await app.close()
  })

  it('deactivating an already-inactive item 409s rather than logging a second pause', async () => {
    const u = await makeUser('act-deactivate-twice@test.com')
    const app = await buildTestApp(u.id)
    const item = await makeDaily(u.id, 'Already off')
    await app.inject({ method: 'POST', url: `/api/items/${item.id}/deactivate` })

    const res = await app.inject({ method: 'POST', url: `/api/items/${item.id}/deactivate` })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toBe('no_change')

    await app.close()
  })

  it('a deleted item cannot be deactivated', async () => {
    const u = await makeUser('act-deactivate-deleted@test.com')
    const app = await buildTestApp(u.id)
    const item = await makeDaily(u.id, 'Deleted')
    await app.inject({ method: 'DELETE', url: `/api/items/${item.id}` })

    const res = await app.inject({ method: 'POST', url: `/api/items/${item.id}/deactivate` })
    expect(res.statusCode).toBe(404)

    await app.close()
  })
})

// ── The list ─────────────────────────────────────────────────────────────────

describe('§5.6 — GET /items returns the active slice unless asked otherwise', () => {
  async function seedOneOfEach(userId: string, app: FastifyInstance) {
    const active = await makeDaily(userId, 'Still on')
    const paused = await makeDaily(userId, 'Paused')
    await app.inject({ method: 'POST', url: `/api/items/${paused.id}/deactivate` })
    return { active, paused }
  }

  it('the default response excludes inactive items', async () => {
    const u = await makeUser('act-items-default@test.com')
    const app = await buildTestApp(u.id)
    const { active, paused } = await seedOneOfEach(u.id, app)

    const ids = idsOf(await app.inject({ method: 'GET', url: '/api/items' }))
    expect(ids).toContain(active.id)
    expect(ids).not.toContain(paused.id)

    await app.close()
  })

  it('status=inactive returns exactly the paused items, with their schedules', async () => {
    const u = await makeUser('act-items-inactive@test.com')
    const app = await buildTestApp(u.id)
    const { active, paused } = await seedOneOfEach(u.id, app)

    const res = await app.inject({ method: 'GET', url: '/api/items?status=inactive' })
    const body = JSON.parse(res.body) as Array<{ id: string; schedules: unknown[] }>
    expect(body.map((i) => i.id)).toEqual([paused.id])
    expect(body.map((i) => i.id)).not.toContain(active.id)
    // Schedules travel with it, so the inactive list can show when it used to happen.
    expect(body[0].schedules).toHaveLength(1)

    await app.close()
  })

  it('status=all returns both', async () => {
    const u = await makeUser('act-items-all@test.com')
    const app = await buildTestApp(u.id)
    const { active, paused } = await seedOneOfEach(u.id, app)

    const ids = idsOf(await app.inject({ method: 'GET', url: '/api/items?status=all' }))
    expect(ids).toContain(active.id)
    expect(ids).toContain(paused.id)

    await app.close()
  })

  it('an unrecognised status is refused, not silently treated as the default', async () => {
    const u = await makeUser('act-items-bad-status@test.com')
    const app = await buildTestApp(u.id)

    const res = await app.inject({ method: 'GET', url: '/api/items?status=archived' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('invalid_status')

    await app.close()
  })

  it('a deleted item is in neither slice — pausing and deleting are separate states', async () => {
    const u = await makeUser('act-items-deleted@test.com')
    const app = await buildTestApp(u.id)
    const item = await makeDaily(u.id, 'Deleted')
    await app.inject({ method: 'DELETE', url: `/api/items/${item.id}` })

    expect(idsOf(await app.inject({ method: 'GET', url: '/api/items?status=inactive' })))
      .not.toContain(item.id)
    expect(idsOf(await app.inject({ method: 'GET', url: '/api/items?status=all' })))
      .not.toContain(item.id)

    await app.close()
  })
})

// ── Editing while paused ─────────────────────────────────────────────────────

describe('§5.6 — an inactive item stays fully editable', () => {
  it('PATCH /items/:id works while paused and does not switch it back on', async () => {
    const u = await makeUser('act-edit-while-paused@test.com')
    const app = await buildTestApp(u.id)

    const item = await createItem(getTestPool(), {
      userId: u.id, name: 'Old name',
      recurrenceRule: { type: 'daily' }, creationSource: 'planned',
      timingPrecision: 'point', timingStartTime: '08:30',
    })
    await app.inject({ method: 'POST', url: `/api/items/${item.id}/deactivate` })

    const patch = await app.inject({
      method: 'PATCH', url: `/api/items/${item.id}`,
      payload: { name: 'New name', timingStartTime: '19:00' },
    })
    expect(patch.statusCode).toBe(200)

    const detail = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/items/${item.id}` })).body
    ) as {
      name: string
      deactivatedAt: string | null
      schedules: Array<{ timingStartTime: string }>
    }
    expect(detail.name).toBe('New name')
    expect(detail.schedules[0].timingStartTime).toBe('19:00:00')
    expect(detail.deactivatedAt).not.toBeNull()

    await app.close()
  })

  it('a slot can be added while paused — keeping the configuration is the whole point', async () => {
    const u = await makeUser('act-add-slot-while-paused@test.com')
    const app = await buildTestApp(u.id)
    const item = await makeDaily(u.id, 'Two blocks later')
    await app.inject({ method: 'POST', url: `/api/items/${item.id}/deactivate` })

    const res = await app.inject({
      method: 'POST', url: `/api/items/${item.id}/schedules`,
      payload: {
        recurrenceRule: { type: 'daily' },
        timingPrecision: 'point',
        timingStartTime: '13:00',
      },
    })
    expect(res.statusCode).toBe(201)

    await app.close()
  })
})

// ── The tree invariant ───────────────────────────────────────────────────────

describe('§5.6 — nothing active is ever created or restored under an inactive parent', () => {
  it('POST /items with an inactive parentId is refused', async () => {
    const u = await makeUser('act-child-of-paused@test.com')
    const app = await buildTestApp(u.id)
    const parent = await makeDaily(u.id, 'Morning routine')
    await app.inject({ method: 'POST', url: `/api/items/${parent.id}/deactivate` })

    const res = await app.inject({
      method: 'POST', url: '/api/items',
      payload: { name: 'Stretch', parentId: parent.id, recurrenceRule: { type: 'daily' } },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toBe('parent_inactive')

    await app.close()
  })

  it('PATCH re-parenting under an inactive item is refused', async () => {
    const u = await makeUser('act-reparent-under-paused@test.com')
    const app = await buildTestApp(u.id)
    const parent = await makeDaily(u.id, 'Morning routine')
    const loose = await makeDaily(u.id, 'Stretch')
    await app.inject({ method: 'POST', url: `/api/items/${parent.id}/deactivate` })

    const res = await app.inject({
      method: 'PATCH', url: `/api/items/${loose.id}`, payload: { parentId: parent.id },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toBe('parent_inactive')

    await app.close()
  })

  it('reactivating a child while its parent is still paused is refused', async () => {
    const u = await makeUser('act-reactivate-child-only@test.com')
    const app = await buildTestApp(u.id)
    const parent = await makeDaily(u.id, 'Morning routine')
    const child = await makeDaily(u.id, 'Stretch', parent.id)
    await app.inject({ method: 'POST', url: `/api/items/${parent.id}/deactivate` })

    const res = await app.inject({ method: 'POST', url: `/api/items/${child.id}/reactivate` })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toBe('ancestor_inactive')

    await app.close()
  })
})

// ── Scoping ──────────────────────────────────────────────────────────────────

describe('§13.4 — one user cannot deactivate another user item', () => {
  it('deactivating an item belonging to someone else 404s', async () => {
    const owner = await makeUser('act-owner@test.com')
    const other = await makeUser('act-other@test.com')
    const item = await makeDaily(owner.id, 'Not yours')

    const app = await buildTestApp(other.id)
    const res = await app.inject({ method: 'POST', url: `/api/items/${item.id}/deactivate` })
    expect(res.statusCode).toBe(404)

    await app.close()
  })
})

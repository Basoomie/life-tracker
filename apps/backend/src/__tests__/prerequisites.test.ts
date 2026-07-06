// §4.2 — Prerequisites integration tests.
// Named after the spec's stated rules.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from './helpers/test-db'
import * as repos from '../db/repos/index'
import {
  addPrerequisite,
  removePrerequisite,
  isBlocked,
  wouldFormCycle,
  validateNotHabit,
} from '../domain/prerequisites'
import { completeLeaf } from '../domain/completion'
import { ensureOccurrenceMaterialized } from '../domain/materialization'
import type { Item } from '@tracker/shared'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TODAY = '2025-01-15'

async function makeUser(email: string) {
  return repos.insertUser(getTestPool(), { email })
}

async function makeTask(userId: string, name: string) {
  return repos.insertItem(getTestPool(), {
    userId,
    name,
    recurrenceRule: null,   // task = no recurrence
    creationSource: 'planned',
  })
}

async function makeHabit(userId: string, name: string) {
  return repos.insertItem(getTestPool(), {
    userId,
    name,
    recurrenceRule: { type: 'daily' },
    creationSource: 'planned',
  })
}

async function completeTask(item: Item, userId: string) {
  const occ = await ensureOccurrenceMaterialized(getTestPool(), item, TODAY, userId)
  await completeLeaf(getTestPool(), occ, userId)
}

// ── §4.2 Task-to-task only ────────────────────────────────────────────────────

describe('§4.2 task-to-task only — habits cannot participate on either end', () => {
  it('§4.2 habit cannot be used as a prerequisite', () => {
    const fakeHabit = {
      id: 'fake-habit',
      recurrenceRule: { type: 'daily' as const },
    } as Item

    const err = validateNotHabit(fakeHabit, 'prerequisite')
    expect(err).not.toBeNull()
    expect(err).toContain('recurring habit')
  })

  it('§4.2 habit cannot have a prerequisite', () => {
    const fakeHabit = {
      id: 'fake-habit',
      recurrenceRule: { type: 'daily' as const },
    } as Item

    const err = validateNotHabit(fakeHabit, 'item')
    expect(err).not.toBeNull()
    expect(err).toContain('recurring habit')
  })

  it('§4.2 addPrerequisite rejects habit as prerequisite (DB check)', async () => {
    const u = await makeUser('prereq-habit-blocker@test.com')
    const task  = await makeTask(u.id, 'Task A')
    const habit = await makeHabit(u.id, 'Habit B')

    const result = await addPrerequisite(getTestPool(), task, habit, u.id)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('recurring habit')
    }
  })

  it('§4.2 addPrerequisite rejects habit as the item (habit cannot have prerequisites)', async () => {
    const u = await makeUser('prereq-habit-item@test.com')
    const habit = await makeHabit(u.id, 'Habit that wants prereq')
    const task  = await makeTask(u.id, 'Prereq task')

    const result = await addPrerequisite(getTestPool(), habit, task, u.id)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('recurring habit')
    }
  })
})

// ── §4.2 Single prerequisite ──────────────────────────────────────────────────

describe('§4.2 item is blocked until all prerequisites have a completion event', () => {
  it('§4.2 item is blocked when prerequisite is not yet complete', async () => {
    const u = await makeUser('prereq-single-blocked@test.com')
    const prereqTask = await makeTask(u.id, 'Prereq A')
    const item       = await makeTask(u.id, 'Item B')

    await addPrerequisite(getTestPool(), item, prereqTask, u.id)

    const blocked = await isBlocked(getTestPool(), item.id, u.id)
    expect(blocked).toBe(true)
  })

  it('§4.2 item is unblocked after its single prerequisite is completed', async () => {
    const u = await makeUser('prereq-single-unblocked@test.com')
    const prereqTask = await makeTask(u.id, 'Prereq unblock A')
    const item       = await makeTask(u.id, 'Item unblock B')

    await addPrerequisite(getTestPool(), item, prereqTask, u.id)
    expect(await isBlocked(getTestPool(), item.id, u.id)).toBe(true)

    await completeTask(prereqTask, u.id)
    expect(await isBlocked(getTestPool(), item.id, u.id)).toBe(false)
  })

  it('§4.2 item with no prerequisites is never blocked', async () => {
    const u = await makeUser('prereq-none@test.com')
    const item = await makeTask(u.id, 'No prereq item')

    expect(await isBlocked(getTestPool(), item.id, u.id)).toBe(false)
  })
})

// ── §4.2 AND semantics — multi-prerequisite ───────────────────────────────────

describe('§4.2 AND semantics: item blocked if ANY prerequisite is incomplete', () => {
  it('§4.2 item blocked if any prerequisite is incomplete (multi-prereq)', async () => {
    const u  = await makeUser('prereq-and-partial@test.com')
    const p1 = await makeTask(u.id, 'Prereq AND-1')
    const p2 = await makeTask(u.id, 'Prereq AND-2')
    const item = await makeTask(u.id, 'Item AND')

    await addPrerequisite(getTestPool(), item, p1, u.id)
    await addPrerequisite(getTestPool(), item, p2, u.id)

    // Complete only p1
    await completeTask(p1, u.id)
    expect(await isBlocked(getTestPool(), item.id, u.id)).toBe(true)   // p2 still incomplete

    // Complete p2 too
    await completeTask(p2, u.id)
    expect(await isBlocked(getTestPool(), item.id, u.id)).toBe(false)  // all complete
  })

  it('§4.2 item unblocked only when ALL prerequisites complete', async () => {
    const u  = await makeUser('prereq-and-all@test.com')
    const p1 = await makeTask(u.id, 'All-P1')
    const p2 = await makeTask(u.id, 'All-P2')
    const p3 = await makeTask(u.id, 'All-P3')
    const item = await makeTask(u.id, 'All-Item')

    await addPrerequisite(getTestPool(), item, p1, u.id)
    await addPrerequisite(getTestPool(), item, p2, u.id)
    await addPrerequisite(getTestPool(), item, p3, u.id)

    await completeTask(p1, u.id)
    await completeTask(p2, u.id)
    expect(await isBlocked(getTestPool(), item.id, u.id)).toBe(true)  // p3 still incomplete

    await completeTask(p3, u.id)
    expect(await isBlocked(getTestPool(), item.id, u.id)).toBe(false)
  })
})

// ── §4.2 Chains ───────────────────────────────────────────────────────────────

describe('§4.2 chain (A→B→C): each link unblocks when its blocker completes', () => {
  it('§4.2 chain A→B→C unblocks link by link', async () => {
    const u = await makeUser('prereq-chain@test.com')
    const a = await makeTask(u.id, 'Chain A')
    const b = await makeTask(u.id, 'Chain B')
    const c = await makeTask(u.id, 'Chain C')

    await addPrerequisite(getTestPool(), b, a, u.id)  // B needs A
    await addPrerequisite(getTestPool(), c, b, u.id)  // C needs B

    expect(await isBlocked(getTestPool(), b.id, u.id)).toBe(true)   // B blocked by A
    expect(await isBlocked(getTestPool(), c.id, u.id)).toBe(true)   // C blocked by B (B also blocked)

    await completeTask(a, u.id)
    expect(await isBlocked(getTestPool(), b.id, u.id)).toBe(false)  // B unblocked
    expect(await isBlocked(getTestPool(), c.id, u.id)).toBe(true)   // C still blocked (B not done)

    await completeTask(b, u.id)
    expect(await isBlocked(getTestPool(), c.id, u.id)).toBe(false)  // C unblocked
  })
})

// ── §4.2 Cycle detection ──────────────────────────────────────────────────────

describe('§4.2 cycle creation is rejected at creation time', () => {
  it('§4.2 rejects direct A→B when B→A already exists', async () => {
    const u = await makeUser('prereq-cycle-direct@test.com')
    const a = await makeTask(u.id, 'Cycle A')
    const b = await makeTask(u.id, 'Cycle B')

    // First edge is fine: B needs A
    const first = await addPrerequisite(getTestPool(), b, a, u.id)
    expect(first.ok).toBe(true)

    // Reverse edge: A needs B → would form A→B→A
    const second = await addPrerequisite(getTestPool(), a, b, u.id)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error).toContain('cycle')
  })

  it('§4.2 rejects transitive cycle (A→B→C→A)', async () => {
    const u = await makeUser('prereq-cycle-transitive@test.com')
    const a = await makeTask(u.id, 'Trans A')
    const b = await makeTask(u.id, 'Trans B')
    const c = await makeTask(u.id, 'Trans C')

    await addPrerequisite(getTestPool(), b, a, u.id)  // B needs A
    await addPrerequisite(getTestPool(), c, b, u.id)  // C needs B

    // Closing the cycle: A needs C → A→B→C→A
    const result = await addPrerequisite(getTestPool(), a, c, u.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('cycle')
  })

  it('§4.2 wouldFormCycle correctly identifies cycle risk', async () => {
    const u = await makeUser('prereq-would-cycle@test.com')
    const a = await makeTask(u.id, 'WC A')
    const b = await makeTask(u.id, 'WC B')

    await repos.insertPrerequisite(getTestPool(), b.id, a.id, u.id)  // B needs A
    // Would adding A→B form a cycle? Yes — walk from B, find A
    expect(await wouldFormCycle(getTestPool(), a.id, b.id, u.id)).toBe(true)
    // Would adding C→B? No C here, but a→b in reverse direction — safe
    expect(await wouldFormCycle(getTestPool(), b.id, a.id, u.id)).toBe(false)
  })
})

// ── §4.2 Blocked items remain schedulable and visible ────────────────────────

describe('§4.2 blocked item is still schedulable/visible, excluded from actionable-now', () => {
  it('§4.2 blocked item has a materialized occurrence (visible in plan)', async () => {
    const u = await makeUser('prereq-visible@test.com')
    const prereq = await makeTask(u.id, 'Visible prereq')
    const item   = await makeTask(u.id, 'Visible blocked item')

    await addPrerequisite(getTestPool(), item, prereq, u.id)

    // Can materialize an occurrence even though blocked
    const occ = await ensureOccurrenceMaterialized(getTestPool(), item, TODAY, u.id)
    expect(occ.id).toBeDefined()
    expect(occ.itemId).toBe(item.id)
  })

  it('§4.2 isBlocked = true means item is excluded from actionable-now', async () => {
    const u = await makeUser('prereq-actionable@test.com')
    const prereq = await makeTask(u.id, 'Actionable prereq')
    const item   = await makeTask(u.id, 'Actionable blocked')

    await addPrerequisite(getTestPool(), item, prereq, u.id)
    expect(await isBlocked(getTestPool(), item.id, u.id)).toBe(true)
    // Semantic: the caller uses isBlocked to exclude from actionable surfaces (§4.2 soft gating)
  })
})

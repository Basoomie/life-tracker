// §5.6 — Active / inactive items: the pause, the cascade, and the undo.
//
// Deactivation is the one operation in this file, seen from two directions.  The
// rules it enforces:
//
//   • Forward-only.  Nothing in the past changes.  Untouched occurrences from the
//     effective day forward are cleared (the same machinery a template edit uses,
//     §5.3); occurrences carrying events are left exactly where they are, because
//     they record something that actually happened.
//   • Cascading.  A child is *part of* its parent (§4.1), so pausing a parent pauses
//     its subtree — one logged event per item, never a single event that a reader
//     would have to expand themselves.
//   • Exactly reversible.  Reactivating a parent switches back on precisely those
//     descendants it switched off, which is why every deactivation records the
//     ancestor that cascaded it.  A child the user had already paused on its own
//     stays paused: undoing more than we did would be silent mutation.

import type { Pool } from 'pg'
import type { Item } from '@tracker/shared'
import * as repos from '../db/repos/index'
import { regenerateFutureOccurrences, topUpMaterializationForItem } from './materialization'

export type DeactivationChange = {
  item: Item
  // Every item actually switched by this call, the acted-on item first.  Returned
  // (rather than just a count) so the API can tell the user what the cascade did —
  // "paused, along with 3 sub-tasks" is information they need to have consented to.
  affected: Item[]
  clearedFutureOccurrences: number
}

// Mirrors ScheduleResult (domain/schedules.ts): a refusal carries a machine-readable
// code so the route maps it to a status without re-deriving the reason from prose.
// 'no_change' is a refusal rather than a silent success on purpose — appending a
// second template_deactivated while already paused would make the replayed timeline
// claim a pause restarted when nothing happened.
export type DeactivationResult =
  | { ok: true; value: DeactivationChange }
  | { ok: false; code: 'no_change' | 'ancestor_inactive'; error: string }

/**
 * §5.6 — The nearest inactive ancestor of `item`, or null.
 *
 * Guards the tree invariant the cascade exists to maintain: **no active item ever
 * sits under an inactive ancestor.**  Deactivation upholds it by cascading down;
 * reactivation would break it by switching a child on underneath a still-paused
 * parent, leaving an occurrence whose parent does not appear in any view.
 */
export async function findInactiveAncestor(
  pool: Pool,
  item: Item,
  userId: string
): Promise<Item | null> {
  const seen = new Set<string>([item.id])
  let current = item

  while (current.parentId !== null) {
    if (seen.has(current.parentId)) break   // defensive: the tree is acyclic
    seen.add(current.parentId)
    const parent = await repos.findItemById(pool, current.parentId, userId)
    if (!parent) break
    if (parent.deactivatedAt !== null) return parent
    current = parent
  }
  return null
}

/**
 * §4.1 — The item and its whole descendant subtree, parents before children.
 *
 * Deliberately includes descendants that are already inactive: a pre-paused child
 * must be *recognised* by the walk so the caller can skip it and, crucially, not
 * record a cascade over it — otherwise reactivation would later switch on something
 * the user had chosen to leave off.
 */
async function collectSubtree(pool: Pool, root: Item, userId: string): Promise<Item[]> {
  const ordered: Item[] = [root]
  const seen = new Set<string>([root.id])

  // Breadth-first, guarded by `seen`.  The containment tree is acyclic by
  // construction, but a guard here is cheap and a cycle would otherwise hang.
  for (let i = 0; i < ordered.length; i++) {
    const children = await repos.findChildItems(pool, ordered[i].id, userId)
    for (const child of children) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      ordered.push(child)
    }
  }
  return ordered
}

/**
 * §5.6 — Pause `item` and its subtree, effective `today`.
 *
 * Returns null if the item is already inactive: a repeat call must not append a
 * second `template_deactivated` event, which would make the replayed timeline claim
 * a pause restarted when nothing happened.
 */
export async function deactivateItemTree(
  pool: Pool,
  item: Item,
  userId: string,
  today: string          // YYYY-MM-DD — the logical day the pause takes effect
): Promise<DeactivationResult> {
  const subtree = await collectSubtree(pool, item, userId)

  const affected: Item[] = []
  let clearedTotal = 0

  for (const member of subtree) {
    const isRoot = member.id === item.id
    const paused = await repos.deactivateItem(pool, member.id, userId)

    // Already inactive.  For the root that means the whole call is a no-op; for a
    // descendant it means the user had paused it themselves, and we leave it — and
    // its record — untouched.
    if (!paused) {
      if (isRoot) {
        return { ok: false, code: 'no_change', error: 'That task is already inactive.' }
      }
      continue
    }

    // §5.3 — clear untouched occurrences from today forward.  Passing no scheduleId
    // covers every slot; nothing is re-materialized because the item is no longer
    // returned by the active-item queries the top-up walks.
    const cleared = await regenerateFutureOccurrences(pool, paused, userId, today)
    clearedTotal += cleared

    await repos.insertEvent(pool, {
      userId,
      eventType: 'template_deactivated',
      itemId: paused.id,
      occurrenceId: null,
      // §5.6 — load-bearing: this is the day the paused interval starts, and the only
      // record of it.  A null here would drop the item out of the replayed timeline.
      appliesToDay: today,
      payload: {
        cascadedFrom: isRoot ? null : item.id,
        clearedFutureOccurrences: cleared,
      },
    })

    affected.push(paused)
  }

  return {
    ok: true,
    value: { item: affected[0], affected, clearedFutureOccurrences: clearedTotal },
  }
}

/**
 * §5.6 — Switch `item` back on, effective `today`, along with the descendants that
 * *this item's* deactivation cascaded over.
 */
export async function reactivateItemTree(
  pool: Pool,
  item: Item,
  userId: string,
  today: string          // YYYY-MM-DD — the logical day scheduling resumes
): Promise<DeactivationResult> {
  // Checked before anything is written: reactivating under a paused parent would
  // produce occurrences belonging to a parent that appears in no view.
  const blockedBy = await findInactiveAncestor(pool, item, userId)
  if (blockedBy) {
    return {
      ok: false,
      code: 'ancestor_inactive',
      error: `"${blockedBy.name}" is inactive, and this is part of it (§5.6). Reactivate "${blockedBy.name}" first — that will bring this back with it.`,
    }
  }

  const restored = await repos.reactivateItem(pool, item.id, userId)
  if (!restored) {
    return { ok: false, code: 'no_change', error: 'That task is already active.' }
  }

  await recordReactivation(pool, restored, userId, today, null)
  const affected: Item[] = [restored]

  // Descendants: only the ones this item swept in.  cascadedFrom on each descendant's
  // most recent deactivation is what distinguishes those from a child the user paused
  // deliberately — see wasCascadedFrom.
  const subtree = await collectSubtree(pool, restored, userId)
  for (const member of subtree) {
    if (member.id === restored.id) continue
    if (member.deactivatedAt === null) continue
    if (!(await wasCascadedFrom(pool, member.id, item.id, userId))) continue

    const child = await repos.reactivateItem(pool, member.id, userId)
    if (!child) continue
    await recordReactivation(pool, child, userId, today, item.id)
    affected.push(child)
  }

  return { ok: true, value: { item: restored, affected, clearedFutureOccurrences: 0 } }
}

// Log the reactivation and resume scheduling for one item.
//
// §5.6 — the paused days are NOT backfilled: topUpMaterialization only ever
// materializes from `today` forward, so the gap stays a gap, which is the truth.
async function recordReactivation(
  pool: Pool,
  item: Item,
  userId: string,
  today: string,
  cascadedFrom: string | null
): Promise<void> {
  await repos.insertEvent(pool, {
    userId,
    eventType: 'template_reactivated',
    itemId: item.id,
    occurrenceId: null,
    appliesToDay: today,   // closes the paused interval (exclusive end)
    payload: { cascadedFrom },
  })
  await topUpMaterializationForItem(pool, item, userId, today)
}

/**
 * §5.6 — Was this item's current pause caused by `ancestorId` cascading, rather than
 * by the user pausing it directly?
 *
 * Answered from the event log rather than a stored flag, and from the *most recent*
 * deactivation only: a child paused by its parent, manually reactivated, then paused
 * again on its own must not be swept back on when the parent returns.
 */
async function wasCascadedFrom(
  pool: Pool,
  itemId: string,
  ancestorId: string,
  userId: string
): Promise<boolean> {
  const events = await repos.findTemplateEventsByItem(pool, itemId, userId)
  const deactivations = events
    .filter((e) => e.eventType === 'template_deactivated')
    .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())

  const latest = deactivations[deactivations.length - 1]
  if (!latest || latest.eventType !== 'template_deactivated') return false
  return latest.payload.cascadedFrom === ancestorId
}

// §3.2 — Streak calculator.
//
// Pure functions: DayObservation[] → streak numbers. No DB access, no event
// replay, no item/occurrence concepts (§9.1.1 observation-array seam).
//
// Polymorphic per v1 §10.4:
//   daily  → consecutive days at completionPercent >= 100
//   quota  → consecutive periods where completions >= quotaTarget.count,
//            grouped by quotaTarget.period (§3.2.2)
//
// The whole calculator is expressed through one classification — what role a day
// (or a quota period) plays in the chain — so that the current-streak walk and the
// longest-streak scan can never disagree about what counts as a miss:
//
//   hit    → extends the chain
//   skip   → neither extends nor breaks (excused §3.2; unresolved §3.2.1;
//            boundary-partial quota period §3.2.3)
//   break  → ends the chain
//
// §3.2.5 note: streaks are a display affordance. Layer 2 reasons in rates over
// windows, never streaks.

import type { DayObservation } from '../types'
import type { StreakFinding, DateWindow, QuotaTarget, QuotaPeriodProgress } from '@tracker/shared'

// What a day or period contributes to the chain.
type ChainRole = 'hit' | 'skip' | 'break'

const isCompleted = (obs: DayObservation) => obs.completionPercent >= 100

function byDay(a: DayObservation, b: DayObservation): number {
  return a.day.localeCompare(b.day)
}

// ── Daily ─────────────────────────────────────────────────────────────────────

/**
 * §3.2.1 — Resolution is a function of TIME, not disposition: a day is unresolved
 * only while it is still the current day. A *past* day left `pending` (the
 * auto-close never ran) is a resolved miss — the day ended and it wasn't done.
 */
function dailyRole(obs: DayObservation, currentDay: string): ChainRole {
  // §3.2 excused skips the chain — checked first so it can neither break nor extend.
  if (obs.disposition === 'excused') return 'skip'
  if (isCompleted(obs)) return 'hit'
  if (obs.day >= currentDay) return 'skip'  // §3.2.1 — not yet decided, so not a miss
  return 'break'
}

/**
 * §3.2.4 — Current streak: walk backwards from the most recent observation until
 * the first resolved break. Cost is proportional to the streak's length, not the
 * window's, which is what makes this affordable on the daily surfaces.
 */
function currentDailyStreak(sorted: DayObservation[], currentDay: string): number {
  let streak = 0
  for (let i = sorted.length - 1; i >= 0; i--) {
    const role = dailyRole(sorted[i], currentDay)
    if (role === 'hit') streak++
    else if (role === 'break') break
  }
  return streak
}

// §3.2.4 — Longest streak stays window-scoped: the widest run inside the observations given.
function longestDailyStreak(sorted: DayObservation[], currentDay: string): number {
  let current = 0
  let longest = 0
  for (const obs of sorted) {
    const role = dailyRole(obs, currentDay)
    if (role === 'hit') {
      current++
      if (current > longest) longest = current
    } else if (role === 'break') {
      current = 0
    }
  }
  return longest
}

// ── Quota period grouping (§3.2.2) ────────────────────────────────────────────

type QuotaPeriod = {
  start: string                    // first calendar day of the period
  end: string                      // last calendar day of the period
  observations: DayObservation[]   // only the item's DUE days that fall in it
}

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return dt.toISOString().slice(0, 10)
}

// Monday of the ISO week containing `day`.
function weekStart(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7  // Mon=0 … Sun=6
  return addDays(day, -dow)
}

// The calendar span of the period containing `day`. Spans are derived from a member
// day rather than parsed back out of a key string, so week and month grouping share
// one code path and there is no key format to get wrong.
function periodSpan(day: string, period: 'week' | 'month'): { start: string; end: string } {
  if (period === 'week') {
    const start = weekStart(day)
    return { start, end: addDays(start, 6) }
  }
  const start = day.slice(0, 7) + '-01'
  const [y, m] = start.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()  // day 0 of next month
  return { start, end: `${start.slice(0, 7)}-${String(lastDay).padStart(2, '0')}` }
}

function groupIntoPeriods(sorted: DayObservation[], period: 'week' | 'month'): QuotaPeriod[] {
  const byStart = new Map<string, QuotaPeriod>()
  for (const obs of sorted) {
    const span = periodSpan(obs.day, period)
    let entry = byStart.get(span.start)
    if (!entry) {
      entry = { start: span.start, end: span.end, observations: [] }
      byStart.set(span.start, entry)
    }
    entry.observations.push(obs)
  }
  return Array.from(byStart.values()).sort((a, b) => a.start.localeCompare(b.start))
}

/**
 * §3.2.2 / §3.2.3 — A period is a hit when completions reach the item's actual
 * quota target. It only BREAKS the chain when it fell short *and* we can be sure
 * the shortfall is the user's rather than an artifact of where the window was cut.
 */
function quotaPeriodRole(
  p: QuotaPeriod,
  target: number,
  window: DateWindow,
  currentDay: string
): ChainRole {
  // §3.2 — a period whose every due day was excused skips, as an excused day does.
  if (p.observations.every(o => o.disposition === 'excused')) return 'skip'

  if (p.observations.filter(isCompleted).length >= target) return 'hit'

  // Fell short. Two reasons that is not evidence of a miss:
  // §3.2.1 — the period hasn't finished, so the target can still be met.
  if (p.end >= currentDay) return 'skip'
  // §3.2.3 — the window sliced this period, so it never held all of its due days.
  // The record can't distinguish "missed" from "clipped"; asserting a miss here
  // would also make the streak change when the user merely switches window.
  if (p.start < window.startDay || p.end > window.endDay) return 'skip'

  return 'break'
}

function currentQuotaStreak(
  periods: QuotaPeriod[],
  target: number,
  window: DateWindow,
  currentDay: string
): number {
  let streak = 0
  for (let i = periods.length - 1; i >= 0; i--) {
    const role = quotaPeriodRole(periods[i], target, window, currentDay)
    if (role === 'hit') streak++
    else if (role === 'break') break
  }
  return streak
}

function longestQuotaStreak(
  periods: QuotaPeriod[],
  target: number,
  window: DateWindow,
  currentDay: string
): number {
  let current = 0
  let longest = 0
  for (const p of periods) {
    const role = quotaPeriodRole(p, target, window, currentDay)
    if (role === 'hit') {
      current++
      if (current > longest) longest = current
    } else if (role === 'break') {
      current = 0
    }
  }
  return longest
}

// §3.2.2 — progress of the in-progress period, reported alongside the streak.
function currentPeriodProgress(
  periods: QuotaPeriod[],
  quota: QuotaTarget,
  currentDay: string
): QuotaPeriodProgress | null {
  const active = periods.find(p => p.start <= currentDay && currentDay <= p.end)
  if (!active) return null
  return {
    completed: active.observations.filter(isCompleted).length,
    target: quota.count,
    period: quota.period,
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * §3.2 — Compute the streak finding for one item.
 *
 * @param window     the requested stats window; scopes longestStreak and defines
 *                   the boundaries §3.2.3 treats as indeterminate
 * @param currentDay the day-start-bucketed logical day (v1 §6.7), supplied by the
 *                   caller so this stays pure and deterministic in tests
 * @param quota      the item's quota target, or null for a daily-type streak
 */
export function computeStreak(
  itemId: string,
  userId: string,
  window: DateWindow,
  observations: DayObservation[],
  currentDay: string,
  quota: QuotaTarget | null
): StreakFinding {
  const sorted = [...observations].sort(byDay)

  const dueCount = sorted.length
  const completedCount = sorted.filter(isCompleted).length
  const excusedCount = sorted.filter(o => o.disposition === 'excused').length

  // §3.2.1 — reported separately from the count so the UI never has to pick
  // between a wrong 12 and a wrong 13.
  const todayObs = sorted.find(o => o.day === currentDay)
  const currentDayPending =
    !!todayObs && todayObs.disposition !== 'excused' && !isCompleted(todayObs)

  if (!quota) {
    return {
      type: 'streak',
      userId,
      itemId,
      window,
      streakType: 'daily',
      rawCounts: { dueCount, completedCount, excusedCount },
      currentStreak: currentDailyStreak(sorted, currentDay),
      longestStreak: longestDailyStreak(sorted, currentDay),
      currentDayPending,
      currentPeriodProgress: null,
    }
  }

  const periods = groupIntoPeriods(sorted, quota.period)
  return {
    type: 'streak',
    userId,
    itemId,
    window,
    streakType: 'quota',
    rawCounts: { dueCount, completedCount, excusedCount },
    currentStreak: currentQuotaStreak(periods, quota.count, window, currentDay),
    longestStreak: longestQuotaStreak(periods, quota.count, window, currentDay),
    currentDayPending,
    currentPeriodProgress: currentPeriodProgress(periods, quota, currentDay),
  }
}

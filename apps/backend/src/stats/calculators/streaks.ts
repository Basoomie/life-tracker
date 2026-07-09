// §3.2 — Streak calculator.
//
// Pure function: DayObservation[] → StreakFinding.  No DB access.
//
// Polymorphic per v1 §10.4:
//   daily  → consecutive days where completionPercent >= 100
//   quota  → consecutive weeks where completedCount >= quotaTarget (simplified to
//             ≥1 per week for now; the quota count per period feeds through when
//             Layer 2 needs it — the seam is already here)
//
// Excused days skip the chain: they neither break nor extend the streak (§3.2).
// Skipped / auto_closed / rescheduled / pending days break the streak.
// Missing days (no occurrence) break the streak.
//
// §5.3 note: streaks are a display affordance; Layer 2 reasons in rates over windows.

import type { DayObservation } from '../types'
import type { StreakFinding, DateWindow } from '@tracker/shared'

/**
 * §3.2 — Compute current and longest streak for a daily item.
 * Excused days are skipped (neither break nor extend).
 */
function computeDailyStreak(observations: DayObservation[]): { current: number; longest: number } {
  // Sort by day ascending (observations should already be ordered, but be safe)
  const sorted = [...observations].sort((a, b) => a.day.localeCompare(b.day))

  let current = 0
  let longest = 0

  for (const obs of sorted) {
    if (obs.disposition === 'excused') continue  // skip the chain — neither break nor extend
    if (obs.completionPercent >= 100) {
      current++
      if (current > longest) longest = current
    } else {
      current = 0
    }
  }

  return { current, longest }
}

/**
 * §3.2 — Compute consecutive-period streak for a quota item.
 * Groups observations by ISO week (Mon–Sun) and counts weeks where at least one
 * completion exists.  A week with only excused days is skipped; one with any miss
 * breaks the streak.
 */
function computeQuotaStreak(observations: DayObservation[]): { current: number; longest: number } {
  // Group by ISO week string "YYYY-Www"
  const byWeek = new Map<string, DayObservation[]>()
  for (const obs of observations) {
    const weekKey = isoWeek(obs.day)
    if (!byWeek.has(weekKey)) byWeek.set(weekKey, [])
    byWeek.get(weekKey)!.push(obs)
  }

  const weeks = Array.from(byWeek.keys()).sort()
  let current = 0
  let longest = 0

  for (const week of weeks) {
    const days = byWeek.get(week)!
    const nonExcused = days.filter(d => d.disposition !== 'excused')
    if (nonExcused.length === 0) continue  // all excused — skip period
    const completed = nonExcused.some(d => d.completionPercent >= 100)
    if (completed) {
      current++
      if (current > longest) longest = current
    } else {
      current = 0
    }
  }

  return { current, longest }
}

// Returns ISO week key as "YYYY-Www" (Monday-based).
function isoWeek(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  // Get day of week (0=Sun … 6=Sat), convert to Mon=0 … Sun=6
  const dow = (dt.getUTCDay() + 6) % 7
  // Thursday of the same week
  const thursday = new Date(dt.getTime() - dow * 86_400_000 + 3 * 86_400_000)
  const year = thursday.getUTCFullYear()
  // Week number: days from Jan 4 of that year's Thursday year (Jan 4 is always in week 1)
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const jan4Dow = (jan4.getUTCDay() + 6) % 7
  const weekNum = Math.floor(1 + (thursday.getTime() - jan4.getTime() + jan4Dow * 86_400_000) / (7 * 86_400_000))
  return `${year}-W${String(weekNum).padStart(2, '0')}`
}

/**
 * §3.2 — Compute streak finding.
 * streakType 'daily' for items due on specific days; 'quota' for period-based targets.
 */
export function computeStreak(
  itemId: string,
  userId: string,
  window: DateWindow,
  observations: DayObservation[],
  streakType: 'daily' | 'quota'
): StreakFinding {
  const dueCount = observations.length
  const completedCount = observations.filter(o => o.completionPercent >= 100).length
  const excusedCount = observations.filter(o => o.disposition === 'excused').length

  const { current, longest } =
    streakType === 'daily'
      ? computeDailyStreak(observations)
      : computeQuotaStreak(observations)

  return {
    type: 'streak',
    userId,
    itemId,
    window,
    streakType,
    rawCounts: { dueCount, completedCount, excusedCount },
    currentStreak: current,
    longestStreak: longest,
  }
}

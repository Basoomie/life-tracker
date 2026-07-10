// v2 §6 / §8 (build sequencing) / §9.2 / §9.3 — The review engine's top-level orchestrator.
//
// This is the ONE place that is allowed to see everything: the event log (via the Layer
// 1/1.5/2 top-level APIs in stats/index.ts and stats/layer2.ts), the evidence base, and
// past reviews. Its job is narrow — call every calculator, release the results through the
// gate (release.ts), hand the released facts to the prompt builder (which then has no way
// back to any of this), verify what comes back, render, and store. All statistical and
// epistemic logic lives upstream of this file; this file is orchestration only.

import type { Pool } from 'pg'
import type { DateWindow, ReviewCadence, Review } from '@tracker/shared'
import * as repos from '../db/repos/index'
import * as layer1 from '../stats/index'
import * as layer2 from '../stats/layer2'
import * as release from './release'
import { buildPrompt } from './prompt-builder'
import { callReviewLLM, type ReviewLLMDeps } from './llm-client'
import { verifyRecommendations } from './verification'
import { renderReviewProse } from './render'
import { computeFeedForwardInput, buildFeedForwardOut } from './feed-forward'
import { determineClosedPeriods, resolveWeekStartDay, type ReviewPeriod } from './schedule'
import type { ReleasedFinding } from './types'

async function releaseFactsForItem(
  pool: Pool,
  userId: string,
  itemId: string,
  itemName: string,
  isRecurring: boolean,
  window: DateWindow
): Promise<ReleasedFinding[]> {
  const facts: ReleasedFinding[] = []

  const [adherence, time, procrastination, dataQuality] = await Promise.all([
    layer1.getItemAdherence(pool, userId, itemId, window),
    layer1.getItemTimeStats(pool, userId, itemId, window),
    layer1.getItemProcrastination(pool, userId, itemId, window),
    layer1.getItemDataQuality(pool, userId, itemId, window),
  ])
  facts.push(release.releaseAdherence(adherence, itemName))
  facts.push(release.releaseTimeStats(time, itemName))
  facts.push(release.releaseProcrastination(procrastination, itemName))
  facts.push(release.releaseDataQuality(dataQuality, itemName))

  // §5.3 note: streaks are deliberately never released — see release.ts.

  if (isRecurring) {
    const [cs, ac, tr, dow, tc] = await Promise.all([
      layer2.getContextStability(pool, userId, itemId, window),
      layer2.getAutocorrelation(pool, userId, itemId, window),
      layer2.getTrajectory(pool, userId, itemId, window),
      layer2.getDayOfWeek(pool, userId, itemId, window),
      layer2.getTwoCondition(pool, userId, itemId, window),
    ])
    facts.push(release.releaseContextStability(cs, itemName))
    facts.push(release.releaseAutocorrelation(ac, itemName))
    facts.push(release.releaseTrajectory(tr, itemName))
    facts.push(release.releaseDayOfWeek(dow, itemName))
    facts.push(release.releaseTwoCondition(tc, itemName))
  }

  return facts
}

async function releaseFacts(pool: Pool, userId: string, window: DateWindow): Promise<ReleasedFinding[]> {
  const items = await repos.findItemsByUser(pool, userId)
  // Only top-level items — a parent's adherence fact already ships its per-child
  // breakdown (§3.1), so a child's own facts would be redundant noise in the prompt.
  const topLevel = items.filter((item) => item.parentId === null)

  const facts: ReleasedFinding[] = []
  for (const item of topLevel) {
    const itemFacts = await releaseFactsForItem(pool, userId, item.id, item.name, item.recurrenceRule !== null, window)
    facts.push(...itemFacts)
  }

  const [adHocShare, userDataQuality] = await Promise.all([
    layer1.getAdHocShare(pool, userId, window),
    layer1.getUserDataQuality(pool, userId, window),
  ])
  facts.push(release.releaseAdHocShare(adHocShare))
  facts.push(release.releaseDataQuality(userDataQuality, 'Overall'))

  return facts
}

/**
 * §6.4 / §9.2 — Generate and store one review for one cadence/window pair.
 * Exported for direct testing; runScheduledReviews (below) is the cadence-driven entry
 * point that determines WHICH windows are due.
 */
export async function generateReview(
  pool: Pool,
  userId: string,
  cadence: ReviewCadence,
  window: DateWindow,
  deps?: { llm?: ReviewLLMDeps }
): Promise<Review> {
  const facts = await releaseFacts(pool, userId, window)

  const usableEvidence = await repos.findUsableEvidenceEntries(pool, userId)
  const evidence = release.releaseEvidence(usableEvidence)

  const previousReview = await repos.findLatestReviewByCadence(pool, userId, cadence)
  const feedForwardInput = previousReview ? computeFeedForwardInput(previousReview.feedForwardOut, facts) : []

  const prompt = buildPrompt({ cadence, window, facts, evidence, feedForward: feedForwardInput })
  const rawOutput = await callReviewLLM(prompt, deps?.llm)

  const recommendations = verifyRecommendations(rawOutput.recommendations, evidence, facts)
  const feedForwardOut = buildFeedForwardOut(feedForwardInput, recommendations, facts)
  const prose = renderReviewProse({ cadence, window, facts, narrative: rawOutput.narrative, recommendations })

  const stored = await repos.insertReview(pool, {
    userId,
    cadence,
    window,
    narrative: rawOutput.narrative,
    recommendations,
    feedForwardOut,
    prose,
  })

  await repos.insertEvent(pool, {
    userId,
    eventType: 'review_generated',
    occurrenceId: null,
    itemId: null,
    appliesToDay: window.endDay,
    payload: {
      reviewId: stored.id,
      cadence,
      windowStart: window.startDay,
      windowEnd: window.endDay,
      recommendationCount: recommendations.length,
    },
  })

  return stored
}

/**
 * §9.3 — Scheduled generation entry point. `day` is the logical day that has just started
 * (already day-start-bucketed by the caller — see runBackgroundJob in
 * domain/materialization.ts, which is where a production caller would source it). Runs
 * generateReview for every cadence period that just closed; a normal day closes none.
 */
export async function runScheduledReviews(
  pool: Pool,
  userId: string,
  day: string,
  deps?: { llm?: ReviewLLMDeps }
): Promise<Review[]> {
  const weekStartDay = await resolveWeekStartDay(pool, userId)
  const periods: ReviewPeriod[] = determineClosedPeriods(day, weekStartDay)

  const reviews: Review[] = []
  for (const period of periods) {
    reviews.push(await generateReview(pool, userId, period.cadence, period.window, deps))
  }
  return reviews
}

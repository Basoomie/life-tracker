// §5.3 item 2 — Context stability calculator.
//
// Pure function: SessionObservation[] + DataQualityFinding → ContextStabilityFinding.
// No DB access, no domain knowledge.  Statistics side of the §9.1.1 seam.
//
// Estimator: circular variance of session start-times.
// Not a permutation test (§5.3.1 Finding F).
// Informative: weeks 4–8.
//
// Circular statistics are used because time-of-day wraps at 0/24h.
// A habit that always occurs at 23:30 and 00:30 has low variance, but linear
// variance would compute the wrong answer.
//
// Rayleigh test for power:
//   H₀: timing is uniform (R̄ = 0, V = 1)
//   H₁: timing is concentrated (R̄ > 0, V < 1)
//   Under H₁: power ≈ Φ(√(2n) × R̄ − √(−2 ln α))

import type { SessionObservation } from '../types'
import type { ContextStabilityFinding, DateWindow, DataQualityFinding } from '@tracker/shared'
import { rayleighPower, rayleighMDE } from '../primitives/power'

/**
 * §5.3 — Compute context stability for an item's session start-times.
 *
 * @param itemId      item being analysed
 * @param userId      user scope
 * @param window      date window for which sessions were collected
 * @param sessions    session observations for this item in the window
 * @param dataQuality pre-computed DataQualityFinding for the same item and window
 * @param alpha       nominal α for power calculation (default 0.05)
 * @param targetPower target power for MDE calculation (default 0.80)
 */
export function computeContextStability(
  itemId: string,
  userId: string,
  window: DateWindow,
  sessions: SessionObservation[],
  dataQuality: DataQualityFinding,
  alpha = 0.05,
  targetPower = 0.80
): ContextStabilityFinding {
  const n = sessions.length
  const nDays = new Set(sessions.map(s => s.day)).size

  if (n < 2) {
    return {
      type: 'context_stability',
      estimator: 'variance',
      userId,
      itemId,
      window,
      circularMeanHour: 0,
      circularVariance: 1,   // undefined with < 2 observations; report as maximum spread
      effectSize: 1,
      power: 0,
      minimumDetectableEffect: rayleighMDE(n, alpha, targetPower),
      rawCounts: { nSessions: n, nDays },
      dataQuality,
      sufficiency: {
        status: 'below_floor',
        reason: 'circular variance requires at least 2 session observations',
        nObserved: n,
        nNeeded: 2,
      },
    }
  }

  // Convert each session start-time to an angle θ ∈ [0, 2π)
  // using fractional UTC hour (0–24) → angle = 2π × hour / 24.
  const angles = sessions.map(s => {
    const hour = s.startedAt.getUTCHours() + s.startedAt.getUTCMinutes() / 60
      + s.startedAt.getUTCSeconds() / 3600
    return (2 * Math.PI * hour) / 24
  })

  // Circular mean: C = (1/n) Σ exp(iθ_j)
  let cReal = 0, cImag = 0
  for (const θ of angles) {
    cReal += Math.cos(θ)
    cImag += Math.sin(θ)
  }
  cReal /= n
  cImag /= n

  // Mean resultant length R̄ = |C| ∈ [0, 1]
  const rBar = Math.sqrt(cReal * cReal + cImag * cImag)

  // Circular variance V = 1 − R̄ ∈ [0, 1]
  const circularVariance = 1 - rBar

  // Circular mean angle → fractional hour
  let meanAngle = Math.atan2(cImag, cReal)
  if (meanAngle < 0) meanAngle += 2 * Math.PI
  const circularMeanHour = (meanAngle * 24) / (2 * Math.PI)

  const power = rayleighPower(n, circularVariance, alpha)
  const mde = rayleighMDE(n, alpha, targetPower)

  return {
    type: 'context_stability',
    estimator: 'variance',
    userId,
    itemId,
    window,
    circularMeanHour,
    circularVariance,
    effectSize: circularVariance,
    power,
    minimumDetectableEffect: mde,
    rawCounts: { nSessions: n, nDays },
    dataQuality,
    sufficiency: { status: 'computable' },
  }
}

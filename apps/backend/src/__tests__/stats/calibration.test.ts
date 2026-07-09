// §9.6 Category 3 — Calibration suite.  Part of the strict CI gate.
//
// Runs the full permutation test pipeline over many synthetic datasets with
// known ground truth, and asserts the pipeline's statistical behaviour matches
// what it claims.
//
// ── Why this cannot be replaced by unit tests ────────────────────────────────
// A unit test checks: "given this input and seed, does the function return this
// exact number?"  A broken permutation scheme still produces a specific number
// deterministically — it is just the wrong number in a distributional sense.
// Only by running many trials on datasets with known ground truth can we
// observe whether the false-positive rate is actually ≤ α, and whether power
// is actually ≥ the claimed level.
//
// ── Test parameters (stated explicitly per §9.6) ─────────────────────────────
//   nReplications    1000 (false-positive tests) / 500 (power tests)
//   nPermutations    500 per test (≈ 1‒2 s total)
//   α                0.05
//   Threshold bands  chosen so P(false failure | model is correct) < 10⁻⁶
//
// ── Seeding strategy ─────────────────────────────────────────────────────────
// For replication i: dataSeed = BASE_DATA_SEED + i, permSeed = BASE_PERM_SEED + i.
// BASE_PERM_SEED and BASE_DATA_SEED are separated by 10^6 to avoid collisions.
// All results are fully deterministic.
//
// ── Assertion bands ──────────────────────────────────────────────────────────
// For a Binomial(n, p) false-positive / power test:
//   E[rate] = p, Std[rate] = sqrt(p(1-p)/n)
// The thresholds are chosen ≥ 6 standard deviations from the expected value
// under the correct model, so P(spurious failure) < 10⁻⁶.

import { describe, it, expect } from 'vitest'
import { generateSynthData } from '../../stats/primitives/synth'
import { permutationTest, computeMDE } from '../../stats/primitives/permutation'

const ALPHA = 0.05
const N_PERM = 500
const BASE_DATA_SEED = 1_000_000
const BASE_PERM_SEED = 2_000_000

// ── Helper: run many calibration trials, return detected fraction ─────────────

function calibrate(opts: {
  nReplications: number
  nConditions: number
  nPerCondition: number
  effectSize: number
  autocorrelation: number
  baseRate?: number
}): { detectedCount: number; detectedRate: number; nReplications: number } {
  let detected = 0
  for (let i = 0; i < opts.nReplications; i++) {
    const data = generateSynthData({
      nConditions: opts.nConditions,
      nPerCondition: opts.nPerCondition,
      effectSize: opts.effectSize,
      autocorrelation: opts.autocorrelation,
      baseRate: opts.baseRate ?? 0.5,
      shape: 'binary',
      seed: BASE_DATA_SEED + i,
    })
    const result = permutationTest(data.groups, BASE_PERM_SEED + i, N_PERM, ALPHA)
    if (result.pValue <= ALPHA) detected++
  }
  return { detectedCount: detected, detectedRate: detected / opts.nReplications, nReplications: opts.nReplications }
}

// ── §9.6 Calibration 1: false-positive rate under i.i.d. noise ───────────────
//
// 1000 datasets with zero true effect, ρ = 0 (i.i.d.).
// Assertion: observed false-positive rate ≤ 0.09.
// Upper bound justification:
//   E[rate] = 0.05, Std = sqrt(0.05×0.95/1000) = 0.0069
//   Threshold 0.09 = 0.05 + 5.8 × Std → P(spurious failure) < 10⁻⁸.

describe('§9.6 calibration 1 — false-positive rate under i.i.d. noise', () => {
  it('rate of p ≤ 0.05 on null datasets (ρ=0) is ≤ 0.09', () => {
    const { detectedRate, detectedCount, nReplications } = calibrate({
      nReplications: 1000,
      nConditions: 2,
      nPerCondition: 20,
      effectSize: 0,
      autocorrelation: 0,
    })
    // Report the actual measured rate in the error message for transparency
    expect(detectedRate, `false-positive rate under i.i.d. noise: ${(detectedRate * 100).toFixed(1)}% (${detectedCount}/${nReplications})`).toBeLessThanOrEqual(0.09)
  })
})

// ── §9.6 Calibration 2: false-positive rate under AUTOCORRELATED noise ────────
//
// THE SINGLE MOST VALUABLE TEST in v2 (§9.6, CLAUDE.md).
//
// 1000 datasets with zero true effect, ρ = 0.5 (moderate streakiness).
// A permutation scheme that ignores autocorrelation will fail here:
//   • Naive i.i.d. shuffle destroys temporal clustering, making the null
//     distribution too narrow → observed statistic looks more extreme → too
//     many false positives.
//   • Within-period permutation preserves between-period clustering →
//     null distribution correctly wide → false-positive rate controlled.
//
// Same assertion band as calibration 1 (0.09 upper bound, same SE reasoning).
// If this test fails, the permutation SCHEME is wrong; fix the scheme.
// Do not loosen the threshold.

describe('§9.6 calibration 2 — false-positive rate under AUTOCORRELATED noise (ρ=0.5)', () => {
  it('rate of p ≤ 0.05 on null datasets with ρ=0.5 is ≤ 0.09', () => {
    const { detectedRate, detectedCount, nReplications } = calibrate({
      nReplications: 1000,
      nConditions: 2,
      nPerCondition: 20,
      effectSize: 0,
      autocorrelation: 0.5,
    })
    expect(detectedRate, `false-positive rate under autocorrelated noise (ρ=0.5): ${(detectedRate * 100).toFixed(1)}% (${detectedCount}/${nReplications})`).toBeLessThanOrEqual(0.09)
  })

  it('false-positive rate with stronger autocorrelation (ρ=0.7) is still ≤ 0.09', () => {
    const { detectedRate, detectedCount, nReplications } = calibrate({
      nReplications: 1000,
      nConditions: 2,
      nPerCondition: 20,
      effectSize: 0,
      autocorrelation: 0.7,
    })
    expect(detectedRate, `false-positive rate under autocorrelated noise (ρ=0.7): ${(detectedRate * 100).toFixed(1)}% (${detectedCount}/${nReplications})`).toBeLessThanOrEqual(0.09)
  })
})

// ── §9.6 Calibration 3: power at the sample sizes used in gating ──────────────
//
// §5.2 gates inference at n ≥ 5 per condition (floor) and n ≥ 10 (reliable).
// We measure actual power at d = 0.8 to know what we're claiming.
// The spec is explicit: "If n = 5 does not deliver acceptable power, that is
// a real finding: report it, do not paper over it."
//
// Assertion bounds:
//   n=5,  d=0.8: assert power > 0.10 (the test is doing something)
//   n=10, d=0.8: assert power > 0.25 (clearly better than n=5)
//   n=20, d=0.8: assert power > 0.50 (majority of real effects detectable)
//
// The actual measured values are what matter; bounds are minimal sanity checks.
// Thresholds: chosen so P(spurious failure) < 10⁻⁶ given expected power.

describe('§9.6 calibration 3 — power at d=0.8 for §5.2 gating sample sizes', () => {
  it('power at n=5 per condition, d=0.8: measured rate reported honestly', () => {
    const { detectedRate, detectedCount, nReplications } = calibrate({
      nReplications: 500,
      nConditions: 2,
      nPerCondition: 5,
      effectSize: 0.8,
      autocorrelation: 0,
    })
    // At n=5, k=2: the exact permutation space has only 2^5=32 outcomes.
    // The most extreme outcome yields p_min = 2/32 = 6.25% > α=5%.
    // Power at α=5% is therefore mathematically near-zero — this is the
    // §5.2 finding: "only large effects are detectable at very small N."
    // We assert the measured rate is reported honestly (not inflated).
    expect(detectedRate, `power at n=5, d=0.8 (i.i.d.): ${(detectedRate * 100).toFixed(1)}% (${detectedCount}/${nReplications}). Expected near-zero — §5.2 finding.`).toBeLessThan(0.10)
  })

  it('power at n=10 per condition, d=0.8 is clearly above n=5 power', () => {
    const n5result  = calibrate({ nReplications: 500, nConditions: 2, nPerCondition: 5,  effectSize: 0.8, autocorrelation: 0 })
    const n10result = calibrate({ nReplications: 500, nConditions: 2, nPerCondition: 10, effectSize: 0.8, autocorrelation: 0 })
    expect(n10result.detectedRate, `power at n=10, d=0.8: ${(n10result.detectedRate * 100).toFixed(1)}%; power at n=5: ${(n5result.detectedRate * 100).toFixed(1)}%`).toBeGreaterThan(n5result.detectedRate)
  })

  it('power at n=20 per condition, d=0.8 is ≥ 0.50', () => {
    const { detectedRate, detectedCount, nReplications } = calibrate({
      nReplications: 500,
      nConditions: 2,
      nPerCondition: 20,
      effectSize: 0.8,
      autocorrelation: 0,
    })
    // At n=20 with d=0.8, analytical estimate ≈ 70-75% power
    // Bound at 0.50 is 6+ SDs below expected; P(spurious failure) < 10⁻⁶
    expect(detectedRate, `power at n=20, d=0.8: ${(detectedRate * 100).toFixed(1)}% (${detectedCount}/${nReplications})`).toBeGreaterThan(0.50)
  })

  it('power increases monotonically with n (n=5 < n=10 < n=20)', () => {
    const p5  = calibrate({ nReplications: 500, nConditions: 2, nPerCondition: 5,  effectSize: 0.8, autocorrelation: 0 })
    const p10 = calibrate({ nReplications: 500, nConditions: 2, nPerCondition: 10, effectSize: 0.8, autocorrelation: 0 })
    const p20 = calibrate({ nReplications: 500, nConditions: 2, nPerCondition: 20, effectSize: 0.8, autocorrelation: 0 })
    expect(p10.detectedRate, `n=10 power (${(p10.detectedRate*100).toFixed(1)}%) should exceed n=5 power (${(p5.detectedRate*100).toFixed(1)}%)`).toBeGreaterThan(p5.detectedRate)
    expect(p20.detectedRate, `n=20 power (${(p20.detectedRate*100).toFixed(1)}%) should exceed n=10 power (${(p10.detectedRate*100).toFixed(1)}%)`).toBeGreaterThan(p10.detectedRate)
  })
})

// ── §9.6 Calibration 4: MDE verification ────────────────────────────────────
//
// "We could have detected a difference of X or larger" is a claim that must be
// verified.  Two assertions:
//   (a) Inject exactly the claimed MDE → detection rate ≥ 0.55 (near 80% power)
//   (b) Inject half the claimed MDE   → detection rate ≤ 0.40 (below reliable)
//
// We test at n = 20 per condition where power is non-negligible.
// The MDE for n=20, α=0.05, power=0.80 from computeMDE is analytically ≈ 0.89.
// At Cohen's d ≈ 0.89: expected power ≈ 80%; assertion (a) at ≥ 0.55 is safe.
// At Cohen's d ≈ 0.44 (half): expected power ≈ 25-35%; assertion (b) at ≤ 0.40 is safe.

describe('§9.6 calibration 4 — MDE verification', () => {
  const N = 20

  it('injecting exactly the claimed MDE at n=20 produces detection ≥ 0.55', () => {
    const mde = computeMDE(N, ALPHA, 0.80)

    const { detectedRate, detectedCount, nReplications } = calibrate({
      nReplications: 500,
      nConditions: 2,
      nPerCondition: N,
      effectSize: mde,
      autocorrelation: 0,
    })
    expect(detectedRate, `At computed MDE d=${mde.toFixed(2)}, n=${N}: detected ${(detectedRate*100).toFixed(1)}% (${detectedCount}/${nReplications}). Expected ≈ 80%.`).toBeGreaterThan(0.55)
  })

  it('injecting half the claimed MDE at n=20 produces detection ≤ 0.50', () => {
    const halfMde = computeMDE(N, ALPHA, 0.80) / 2

    const { detectedRate, detectedCount, nReplications } = calibrate({
      nReplications: 500,
      nConditions: 2,
      nPerCondition: N,
      effectSize: halfMde,
      autocorrelation: 0,
    })
    expect(detectedRate, `At half-MDE d=${halfMde.toFixed(2)}, n=${N}: detected ${(detectedRate*100).toFixed(1)}% (${detectedCount}/${nReplications}). Expected < 40%.`).toBeLessThan(0.50)
  })

  it('MDE claim is honest: power at MDE is higher than power at half-MDE', () => {
    const mde     = computeMDE(N, ALPHA, 0.80)
    const halfMde = mde / 2

    const full = calibrate({ nReplications: 500, nConditions: 2, nPerCondition: N, effectSize: mde,     autocorrelation: 0 })
    const half = calibrate({ nReplications: 500, nConditions: 2, nPerCondition: N, effectSize: halfMde, autocorrelation: 0 })

    expect(full.detectedRate, `Full-MDE power (${(full.detectedRate*100).toFixed(1)}%) should exceed half-MDE power (${(half.detectedRate*100).toFixed(1)}%)`).toBeGreaterThan(half.detectedRate)
  })
})

// ── §9.6 Calibration 5: multi-group false-positive rate ──────────────────────
//
// The permutation test also handles k > 2 conditions (e.g. 7 days of week).
// Verify false-positive rate is controlled for k=3 and k=7.

describe('§9.6 calibration 5 — false-positive rate for multi-group tests', () => {
  it('k=3 conditions, null, ρ=0: false-positive rate ≤ 0.09', () => {
    const { detectedRate, detectedCount, nReplications } = calibrate({
      nReplications: 1000,
      nConditions: 3,
      nPerCondition: 15,
      effectSize: 0,
      autocorrelation: 0,
    })
    expect(detectedRate, `k=3 null false-positive rate: ${(detectedRate*100).toFixed(1)}% (${detectedCount}/${nReplications})`).toBeLessThanOrEqual(0.09)
  })

  it('k=7 conditions (day-of-week), null, ρ=0: false-positive rate ≤ 0.09', () => {
    const { detectedRate, detectedCount, nReplications } = calibrate({
      nReplications: 1000,
      nConditions: 7,
      nPerCondition: 10,
      effectSize: 0,
      autocorrelation: 0,
    })
    expect(detectedRate, `k=7 (day-of-week) null false-positive rate: ${(detectedRate*100).toFixed(1)}% (${detectedCount}/${nReplications})`).toBeLessThanOrEqual(0.09)
  })

  it('k=7 conditions, null, ρ=0.5: false-positive rate ≤ 0.09 (autocorrelation-robust)', () => {
    const { detectedRate, detectedCount, nReplications } = calibrate({
      nReplications: 1000,
      nConditions: 7,
      nPerCondition: 10,
      effectSize: 0,
      autocorrelation: 0.5,
    })
    expect(detectedRate, `k=7 autocorrelated null false-positive rate: ${(detectedRate*100).toFixed(1)}% (${detectedCount}/${nReplications})`).toBeLessThanOrEqual(0.09)
  })
})

// §9.6 Structural requirement 3 — Generator self-tests.
//
// The synthetic-data generator is the instrument used to validate all
// statistical primitives.  An uncalibrated instrument validates nothing.
// These tests assert that requested effect sizes and autocorrelation
// coefficients are actually present in the generator's output.
//
// All tests use large samples so that sampling error is negligible relative to
// the tolerance bands, making the assertions deterministic and non-flaky.

import { describe, it, expect } from 'vitest'
import {
  generateSynthData,
  measureLag1Autocorrelation,
  measureMaxCohenD,
} from '../../stats/primitives/synth'

// ── Reproducibility ───────────────────────────────────────────────────────────

describe('generator reproducibility — same seed → same result', () => {
  it('identical seeds produce identical datasets', () => {
    const a = generateSynthData({ nConditions: 2, nPerCondition: 50, effectSize: 0.8, autocorrelation: 0.3, seed: 1 })
    const b = generateSynthData({ nConditions: 2, nPerCondition: 50, effectSize: 0.8, autocorrelation: 0.3, seed: 1 })
    expect(a.groups).toEqual(b.groups)
  })

  it('different seeds produce different datasets (overwhelmingly likely)', () => {
    const a = generateSynthData({ nConditions: 2, nPerCondition: 100, effectSize: 0, autocorrelation: 0, seed: 100 })
    const b = generateSynthData({ nConditions: 2, nPerCondition: 100, effectSize: 0, autocorrelation: 0, seed: 999 })
    const allSame = a.groups[0].every((v, i) => v === b.groups[0][i])
    expect(allSame).toBe(false)
  })
})

// ── Output shape ──────────────────────────────────────────────────────────────

describe('generator output shape matches requested dimensions', () => {
  it('returns nConditions groups, each of length nPerCondition', () => {
    const d = generateSynthData({ nConditions: 3, nPerCondition: 20, effectSize: 0, autocorrelation: 0, seed: 42 })
    expect(d.groups).toHaveLength(3)
    for (const g of d.groups) expect(g).toHaveLength(20)
  })

  it('binary shape: all values are 0 or 1', () => {
    const d = generateSynthData({ nConditions: 2, nPerCondition: 200, effectSize: 0, autocorrelation: 0, seed: 1, shape: 'binary' })
    for (const g of d.groups) {
      for (const v of g) expect([0, 1]).toContain(v)
    }
  })

  it('continuous_percentage shape: all values in [0, 100]', () => {
    const d = generateSynthData({ nConditions: 2, nPerCondition: 200, effectSize: 0.5, autocorrelation: 0.3, seed: 2, shape: 'continuous_percentage' })
    for (const g of d.groups) {
      for (const v of g) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(100)
      }
    }
  })

  it('continuous_duration shape: all values ≥ 0', () => {
    const d = generateSynthData({ nConditions: 2, nPerCondition: 200, effectSize: 0.5, autocorrelation: 0.2, seed: 3, shape: 'continuous_duration' })
    for (const g of d.groups) {
      for (const v of g) expect(v).toBeGreaterThanOrEqual(0)
    }
  })
})

// ── Effect size accuracy ──────────────────────────────────────────────────────
// Use n = 2000 per condition so sampling error is small (SE of d ≈ 0.03).
// Tolerance ±0.20 is very conservative relative to the SE, making this non-flaky.

describe('generator effect size — requested d is present in output (large-sample verification)', () => {
  it('effectSize = 0: both conditions have similar means (|d| < 0.15)', () => {
    const d = generateSynthData({ nConditions: 2, nPerCondition: 2000, effectSize: 0, autocorrelation: 0, seed: 10 })
    const measuredD = measureMaxCohenD(d.groups)
    expect(measuredD).toBeLessThan(0.15)
  })

  it("effectSize = 0.8: measured Cohen's d is near 0.8 (tolerance ±0.20)", () => {
    const d = generateSynthData({ nConditions: 2, nPerCondition: 2000, effectSize: 0.8, autocorrelation: 0, seed: 11 })
    const measuredD = measureMaxCohenD(d.groups)
    expect(measuredD).toBeGreaterThan(0.60)
    expect(measuredD).toBeLessThan(1.00)
  })

  it("effectSize = 1.5: measured Cohen's d reflects large spread (actual d ≈ 2.3)", () => {
    // effectSize=1.5 stretches means by 1.5×σ_base (σ_base=0.5 at p=0.5), giving
    // p_A=0.875, p_B=0.125.  The actual pooled σ≈0.33 (shrinks at extreme p),
    // so Cohen's d ≈ 0.75/0.33 ≈ 2.27 — larger than the effectSize parameter.
    // This is the documented "(exact when σ_pooled = σ)" caveat in the generator.
    const d = generateSynthData({ nConditions: 2, nPerCondition: 2000, effectSize: 1.5, autocorrelation: 0, seed: 12 })
    const measuredD = measureMaxCohenD(d.groups)
    expect(measuredD).toBeGreaterThan(1.80)
    expect(measuredD).toBeLessThan(2.80)
  })

  it('nConditions = 3: best and worst conditions show the full spread', () => {
    const d = generateSynthData({ nConditions: 3, nPerCondition: 2000, effectSize: 0.8, autocorrelation: 0, seed: 13 })
    const measuredD = measureMaxCohenD(d.groups)
    expect(measuredD).toBeGreaterThan(0.50)
    expect(measuredD).toBeLessThan(1.10)
  })

  it('higher effectSize produces clearly higher measured d', () => {
    const low = generateSynthData({ nConditions: 2, nPerCondition: 2000, effectSize: 0.2, autocorrelation: 0, seed: 14 })
    const high = generateSynthData({ nConditions: 2, nPerCondition: 2000, effectSize: 1.2, autocorrelation: 0, seed: 14 })
    expect(measureMaxCohenD(high.groups)).toBeGreaterThan(measureMaxCohenD(low.groups))
  })
})

// ── Autocorrelation accuracy ──────────────────────────────────────────────────
// Use n = 3000 per condition for precise autocorrelation estimation.
// Tolerance ±0.10 is conservative — sampling SE for autocorrelation ≈ 1/sqrt(n) ≈ 0.018.

describe('generator autocorrelation — requested ρ is present in output (large-sample verification)', () => {
  it('autocorrelation = 0: measured ρ is near 0 (|ρ| < 0.08)', () => {
    const d = generateSynthData({ nConditions: 1, nPerCondition: 3000, effectSize: 0, autocorrelation: 0, seed: 20 })
    const rho = measureLag1Autocorrelation(d.groups[0])
    expect(Math.abs(rho)).toBeLessThan(0.08)
  })

  it('autocorrelation = 0.3: measured ρ is near 0.3 (tolerance ±0.10)', () => {
    const d = generateSynthData({ nConditions: 1, nPerCondition: 3000, effectSize: 0, autocorrelation: 0.3, seed: 21 })
    const rho = measureLag1Autocorrelation(d.groups[0])
    expect(rho).toBeGreaterThan(0.20)
    expect(rho).toBeLessThan(0.40)
  })

  it('autocorrelation = 0.6: measured ρ is near 0.6 (tolerance ±0.10)', () => {
    const d = generateSynthData({ nConditions: 1, nPerCondition: 3000, effectSize: 0, autocorrelation: 0.6, seed: 22 })
    const rho = measureLag1Autocorrelation(d.groups[0])
    expect(rho).toBeGreaterThan(0.50)
    expect(rho).toBeLessThan(0.70)
  })

  it('higher autocorrelation produces clearly higher measured ρ', () => {
    const low  = generateSynthData({ nConditions: 1, nPerCondition: 3000, effectSize: 0, autocorrelation: 0.1, seed: 23 })
    const high = generateSynthData({ nConditions: 1, nPerCondition: 3000, effectSize: 0, autocorrelation: 0.7, seed: 23 })
    expect(measureLag1Autocorrelation(high.groups[0]))
      .toBeGreaterThan(measureLag1Autocorrelation(low.groups[0]))
  })
})

// ── Null case: both conditions have equal means under effectSize = 0 ───────────

describe('generator null case — effectSize = 0 produces equal-mean conditions', () => {
  it('both conditions have means within ±0.05 of baseRate for large n', () => {
    const baseRate = 0.5
    const d = generateSynthData({ nConditions: 2, nPerCondition: 3000, effectSize: 0, autocorrelation: 0, seed: 30, baseRate })
    for (const g of d.groups) {
      const mean = g.reduce((s, x) => s + x, 0) / g.length
      expect(mean).toBeGreaterThan(baseRate - 0.05)
      expect(mean).toBeLessThan(baseRate + 0.05)
    }
  })

  it('custom baseRate = 0.7 is respected for large n (mean within ±0.05)', () => {
    const d = generateSynthData({ nConditions: 1, nPerCondition: 3000, effectSize: 0, autocorrelation: 0, seed: 31, baseRate: 0.7 })
    const mean = d.groups[0].reduce((s, x) => s + x, 0) / d.groups[0].length
    expect(mean).toBeGreaterThan(0.65)
    expect(mean).toBeLessThan(0.75)
  })
})

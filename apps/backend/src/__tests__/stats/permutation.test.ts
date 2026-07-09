// §9.6 Category 2 — Known-answer fixtures for the permutation test.
//
// These fixtures prove the machinery of permutation.ts, not merely its
// stability under a seed.  For small cases, the exact p-value is derivable
// by exhaustive enumeration (without sampling), so we can assert agreement
// with a computable ground truth.
//
// ── Exhaustive enumeration helper ────────────────────────────────────────────
// For 2 groups with n periods, the within-period permutation generates 2^n
// possible assignments (each period independently swaps the two values or not).
// For n ≤ 16 this is tractable (≤ 65,536 combinations).
//
// p_exact = (1 + count(|mean(A) − mean(B)|_permuted ≥ T_obs)) / (2^n + 1)
// using the same (1+count)/(total+1) convention as permutationTest.

import { describe, it, expect } from 'vitest'
import { permutationTest, maxCohenD, computeMDE } from '../../stats/primitives/permutation'

// ── Exhaustive p-value for 2 groups ──────────────────────────────────────────

function exhaustivePValue(groupA: readonly number[], groupB: readonly number[]): number {
  const n = groupA.length
  if (n !== groupB.length) throw new Error('groups must be equal length')
  if (n > 20) throw new Error('exhaustive enumeration only practical for n ≤ 20')

  function mean(arr: number[]): number { return arr.reduce((s, x) => s + x, 0) / arr.length }

  const tObs = Math.abs(mean(groupA as number[]) - mean(groupB as number[]))

  let countGte = 0
  const total = 1 << n  // 2^n

  for (let mask = 0; mask < total; mask++) {
    const pA = groupA.slice() as number[]
    const pB = groupB.slice() as number[]
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        // Swap period i
        const tmp = pA[i]; pA[i] = pB[i]; pB[i] = tmp
      }
    }
    const tPerm = Math.abs(mean(pA) - mean(pB))
    if (tPerm >= tObs) countGte++
  }

  // Exact p-value: fraction of all 2^n within-period permutations (including
  // the identity, mask=0) that produce T_perm ≥ T_obs.
  // The Monte Carlo test uses (1+count)/(nPerm+1) which converges to this
  // as nPerm→∞, because the "+1" accounts for the identity permutation.
  return countGte / total
}

// ── Known-answer fixtures ─────────────────────────────────────────────────────

describe('§9.6 permutation test known-answer: perfect separation (n=3 periods)', () => {
  // A = [1,1,1], B = [0,0,0]  →  T_obs = 1
  // All 2^3 = 8 within-period permutations:
  //   (no swap):  A=[1,1,1], B=[0,0,0] → diff=1  ✓
  //   (swap p0):  A=[0,1,1], B=[1,0,0] → diff=1/3
  //   (swap p1):  A=[1,0,1], B=[0,1,0] → diff=1/3
  //   (swap p2):  A=[1,1,0], B=[0,0,1] → diff=1/3
  //   (swap p0+1): A=[0,0,1], B=[1,1,0] → diff=1/3
  //   (swap p0+2): A=[0,1,0], B=[1,0,1] → diff=1/3
  //   (swap p1+2): A=[1,0,0], B=[0,1,1] → diff=1/3
  //   (swap all):  A=[0,0,0], B=[1,1,1] → diff=1  ✓
  // Permutations with diff ≥ 1: 2 out of 8.
  // p_exact = 2/8 = 1/4 = 0.25
  it('exhaustive p-value for perfect separation, n=3 is 2/8', () => {
    const pExact = exhaustivePValue([1, 1, 1], [0, 0, 0])
    expect(pExact).toBeCloseTo(2 / 8, 6)
  })

  it('Monte Carlo agrees with exhaustive to within ±0.05 (large nPermutations)', () => {
    const result = permutationTest([[1, 1, 1], [0, 0, 0]], 42, 10_000)
    // Exact p = 2/8 = 0.25 from exhaustive enumeration
    expect(result.pValue).toBeGreaterThan(0.20)
    expect(result.pValue).toBeLessThan(0.30)
  })
})

describe('§9.6 permutation test known-answer: identical groups (n=3 periods)', () => {
  // A = [1,0,1], B = [1,0,1]  →  T_obs = 0
  // All permutations also have T_perm = 0 (the values are identical per period).
  // p_exact = (1 + 2^3) / (2^3 + 1) = 9/9 = 1.0
  it('identical groups produce p ≈ 1.0 (all permutations tie or beat observed)', () => {
    const pExact = exhaustivePValue([1, 0, 1], [1, 0, 1])
    expect(pExact).toBeCloseTo(1.0, 6)
  })

  it('Monte Carlo gives p ≈ 1.0 for identical groups', () => {
    const result = permutationTest([[1, 0, 1], [1, 0, 1]], 7, 5_000)
    expect(result.pValue).toBeGreaterThan(0.95)
  })
})

describe('§9.6 permutation test known-answer: moderate separation (n=4 periods)', () => {
  // A = [1,1,1,1], B = [0,0,0,0]  →  T_obs = 1
  // 2^4 = 16 permutations.
  // Permutations with diff ≥ 1: only (no swap) and (all swap) → 2 out of 16.
  // p_exact = 2/16 = 1/8 = 0.125
  it('exhaustive p-value for n=4 perfect separation is 2/16', () => {
    const pExact = exhaustivePValue([1, 1, 1, 1], [0, 0, 0, 0])
    expect(pExact).toBeCloseTo(2 / 16, 6)
  })

  it('Monte Carlo agrees with exhaustive to within ±0.05 for n=4', () => {
    const result = permutationTest([[1, 1, 1, 1], [0, 0, 0, 0]], 99, 10_000)
    // Exact p = 2/16 = 0.125
    expect(result.pValue).toBeGreaterThan(0.075)
    expect(result.pValue).toBeLessThan(0.175)
  })
})

describe('§9.6 permutation test known-answer: asymmetric case (n=5)', () => {
  // A = [1,1,1,0,1], B = [0,0,0,1,0]  →  T_obs = |4/5 - 1/5| = 3/5 = 0.6
  // Exhaustive: 2^5 = 32 permutations.
  // Permutations with |mean(A) - mean(B)| ≥ 0.6:
  //   The maximum diff is 1 (if all swapped correctly) or 0.6.
  //   Diff = 1 if the same period (period 3) that currently pulls B up is
  //   reassigned to B and all others go to A.  Let's count by exhaustive helper.
  it('exhaustive p-value matches Monte Carlo to within ±0.05', () => {
    const A = [1, 1, 1, 0, 1]
    const B = [0, 0, 0, 1, 0]
    const pExact = exhaustivePValue(A, B)
    const result = permutationTest([A, B], 77, 10_000)
    expect(result.pValue).toBeGreaterThan(pExact - 0.05)
    expect(result.pValue).toBeLessThan(pExact + 0.05)
  })
})

// ── Seeding ───────────────────────────────────────────────────────────────────

describe('§9.6 permutation test seeding — same seed → same result', () => {
  it('identical seeds produce identical p-values', () => {
    const A = [1, 0, 1, 1, 0, 0, 1, 1, 0, 1]
    const B = [0, 1, 0, 0, 1, 1, 0, 0, 1, 0]
    const r1 = permutationTest([A, B], 12345, 500)
    const r2 = permutationTest([A, B], 12345, 500)
    expect(r1.pValue).toBe(r2.pValue)
    expect(r1.effectSize).toBe(r2.effectSize)
  })

  it('different seeds may produce different p-values (sampling variance)', () => {
    const A = [1, 0, 1, 1, 0, 0, 1, 1, 0, 1]
    const B = [0, 1, 0, 0, 1, 1, 0, 0, 1, 0]
    const r1 = permutationTest([A, B], 1, 200)
    const r2 = permutationTest([A, B], 999999, 200)
    // Not guaranteed to differ, but practically always will with different seeds and few permutations
    // We just verify they're both valid p-values
    expect(r1.pValue).toBeGreaterThan(0)
    expect(r2.pValue).toBeGreaterThan(0)
    expect(r1.pValue).toBeLessThanOrEqual(1)
    expect(r2.pValue).toBeLessThanOrEqual(1)
  })
})

// ── Output validity ───────────────────────────────────────────────────────────

describe('§9.6 permutation test output invariants', () => {
  it('p-value is in (0, 1]', () => {
    const result = permutationTest([[1, 1, 1], [0, 0, 0]], 1, 1000)
    expect(result.pValue).toBeGreaterThan(0)
    expect(result.pValue).toBeLessThanOrEqual(1)
  })

  it('effectSize ≥ 0', () => {
    const result = permutationTest([[1, 0, 1], [0, 1, 0]], 2, 500)
    expect(result.effectSize).toBeGreaterThanOrEqual(0)
  })

  it('observedStatistic ≥ 0', () => {
    const result = permutationTest([[0.5, 0.6, 0.4], [0.4, 0.5, 0.6]], 3, 500)
    expect(result.observedStatistic).toBeGreaterThanOrEqual(0)
  })

  it('nPermutations in result matches argument', () => {
    const result = permutationTest([[1, 0], [0, 1]], 4, 123)
    expect(result.nPermutations).toBe(123)
  })

  it('minimumDetectableEffect > 0', () => {
    const result = permutationTest([[1, 0, 1], [0, 1, 0]], 5, 500)
    expect(result.minimumDetectableEffect).toBeGreaterThan(0)
  })

  it('throws when groups have unequal length', () => {
    expect(() => permutationTest([[1, 2, 3], [1, 2]], 1)).toThrow()
  })

  it('throws when fewer than 2 groups provided', () => {
    expect(() => permutationTest([[1, 2, 3]], 1)).toThrow()
  })
})

// ── Effect size ───────────────────────────────────────────────────────────────

describe('§9.6 maxCohenD — effect size computation', () => {
  it('maxCohenD = 0 for identical groups', () => {
    const d = maxCohenD([[1, 0, 1, 0], [1, 0, 1, 0]])
    expect(d).toBe(0)
  })

  it('maxCohenD increases with larger mean difference', () => {
    // Use arrays with actual variance — constant arrays have pooledStd=0 (undefined d)
    const close = maxCohenD([[0.6, 0.4, 0.5, 0.6, 0.4], [0.5, 0.3, 0.4, 0.5, 0.3]])
    const far   = maxCohenD([[0.9, 0.8, 0.9, 0.8, 0.9], [0.1, 0.2, 0.1, 0.2, 0.1]])
    expect(far).toBeGreaterThan(close)
  })

  it('maxCohenD is symmetric (A vs B = B vs A)', () => {
    const A = [0.7, 0.8, 0.6]
    const B = [0.3, 0.2, 0.4]
    expect(maxCohenD([A, B])).toBeCloseTo(maxCohenD([B, A]), 10)
  })
})

// ── MDE ──────────────────────────────────────────────────────────────────────

describe('§9.6 computeMDE — minimum detectable effect', () => {
  it('MDE decreases as n increases (more data → smaller detectable effect)', () => {
    const mde5  = computeMDE(5)
    const mde10 = computeMDE(10)
    const mde20 = computeMDE(20)
    expect(mde10).toBeLessThan(mde5)
    expect(mde20).toBeLessThan(mde10)
  })

  it('MDE is positive for any valid input', () => {
    expect(computeMDE(5)).toBeGreaterThan(0)
    expect(computeMDE(100)).toBeGreaterThan(0)
  })

  it('MDE with tighter alpha produces larger MDE (harder to reject null)', () => {
    const mde_05 = computeMDE(10, 0.05)
    const mde_01 = computeMDE(10, 0.01)
    expect(mde_01).toBeGreaterThan(mde_05)
  })

  it('MDE with lower power produces smaller MDE (easier bar)', () => {
    const mde_80 = computeMDE(10, 0.05, 0.80)
    const mde_50 = computeMDE(10, 0.05, 0.50)
    expect(mde_50).toBeLessThan(mde_80)
  })

  it('n=5 MDE is substantially larger than 0.8 — key design finding', () => {
    // At n=5 per condition, even d=0.8 effects are below the MDE at 80% power.
    // This is the §5.1 finding: "only large effects are detectable at N-of-1."
    const mde = computeMDE(5, 0.05, 0.80)
    expect(mde).toBeGreaterThan(0.8)
  })
})

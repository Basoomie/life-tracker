// §9.6 Category 2 / §5.1–§5.2 / §9.1.1 — Statistical primitives.
//
// Written from scratch per CLAUDE.md rule 4 / §9.1:
//   "A wrong permutation test would silently produce confident nonsense —
//    the exact failure mode this entire design exists to prevent."
//
// PURE FUNCTIONS ONLY.  Zero domain knowledge — no DB, no event replay, no
// occurrence/item/day-start concepts.  This is the statistics side of §9.1.1's
// observation-array seam.  These functions are usable on synthetic arrays with
// no event log in sight.
//
// ── Permutation scheme: within-period permutation ────────────────────────────
//
// Input: groups[g][k] = observation from condition g in period k.
// All groups must have the same length n (n periods).
//
// For each permutation: for each period k, randomly reassign the k-th
// observation across all conditions (a Fisher–Yates shuffle of the period's
// values).  The between-period structure is untouched.
//
// WHY THIS HANDLES AUTOCORRELATION
// Habit data has temporal autocorrelation: a successful period k raises the
// probability of success in period k+1 (§5.1, "streaks are an autocorrelation
// phenomenon").  This creates between-period clustering: a "good week" tends to
// produce above-average values for ALL conditions measured that week.
//
// Within-period permutation preserves this clustering: period k's values are
// still period k's values — they are just randomly reassigned across conditions.
// A naive i.i.d. shuffle would scatter period-k observations to arbitrary period
// slots, generating a null distribution that ignores the between-period
// variability and therefore appears narrower than it truly is.  A narrower null
// distribution makes the observed statistic appear more extreme than it really
// is → systematically anti-conservative (too-small) p-values.
//
// Independence from the generator: synth.ts creates autocorrelation through a
// Markov carry-over process (state: yesterday's outcome; the transition
// P(success|prev success) > P(success|prev failure) drives streaks).  This
// mechanism creates dependencies in the temporal direction — it knows nothing
// about "periods" or "conditions."  Within-period permutation exploits period
// structure; the generator exploits consecutive-day structure.  They are
// mechanically independent assumptions, so the generator cannot vacuously pass
// the autocorrelation robustness calibration test.
//
// ── Test statistic ───────────────────────────────────────────────────────────
// max pairwise |mean(g_i) − mean(g_j)| across all condition pairs.
// For two groups this reduces to |mean(A) − mean(B)|.
// Straightforward, interpretable, scales with the same standard deviation as
// Cohen's d.
//
// ── p-value convention ───────────────────────────────────────────────────────
// p = (1 + count(T_π ≥ T_obs)) / (nPermutations + 1)
// The "+1" in numerator and denominator counts the observed data itself as one
// permutation, ensuring p > 0 and matching the standard randomisation-test
// convention (Phipson & Smyth 2010).
//
// ── MDE formula ──────────────────────────────────────────────────────────────
// Analytical approximation for a two-group test with equal group size n:
//   MDE_d ≈ sqrt(2/n) × (z_{1−α/2} + z_{1−β})
// Derived from the normal approximation to the permutation test statistic
// distribution.  For binary data with σ ≈ 0.5 this is the Cohen's d MDE.
// The calibration suite verifies this approximation holds for our test.

export type PermutationTestResult = {
  pValue: number
  effectSize: number        // max pairwise Cohen's d (best vs worst condition)
  observedStatistic: number // |mean_best − mean_worst| (unstandardised)
  nPermutations: number     // number of permutations run (not counting observed)
  minimumDetectableEffect: number  // Cohen's d at requested alpha and power
  seed: number
}

// ── Seeded PRNG (mulberry32) ──────────────────────────────────────────────────
function mkRng(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Array utilities ───────────────────────────────────────────────────────────

function arrayMean(arr: readonly number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((s, x) => s + x, 0) / arr.length
}

function arrayVariance(arr: readonly number[]): number {
  if (arr.length < 2) return 0
  const m = arrayMean(arr)
  return arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1)
}

// Fisher–Yates shuffle of an array in-place.
function shuffleInPlace(arr: number[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp
  }
}

// ── Test statistic ────────────────────────────────────────────────────────────

// max pairwise |mean(g_i) − mean(g_j)| across all pairs.
function maxPairwiseMeanDiff(groups: readonly (readonly number[])[]): number {
  let max = 0
  for (let i = 0; i < groups.length; i++) {
    const mi = arrayMean(groups[i])
    for (let j = i + 1; j < groups.length; j++) {
      const diff = Math.abs(mi - arrayMean(groups[j]))
      if (diff > max) max = diff
    }
  }
  return max
}

// ── Effect size ───────────────────────────────────────────────────────────────

/**
 * Max pairwise Cohen's d across all condition pairs.
 * Uses pooled standard deviation (equal-sample-size variant).
 * Returns 0 if all groups have zero variance (degenerate data).
 */
export function maxCohenD(groups: readonly (readonly number[])[]): number {
  let maxD = 0
  for (let i = 0; i < groups.length; i++) {
    const mi = arrayMean(groups[i])
    const vi = arrayVariance(groups[i])
    for (let j = i + 1; j < groups.length; j++) {
      const mj = arrayMean(groups[j])
      const vj = arrayVariance(groups[j])
      const pooledStd = Math.sqrt((vi + vj) / 2)
      if (pooledStd === 0) continue
      const d = Math.abs(mi - mj) / pooledStd
      if (d > maxD) maxD = d
    }
  }
  return maxD
}

// ── MDE (minimum detectable effect) ──────────────────────────────────────────

/**
 * Analytical MDE (Cohen's d) for a two-group within-period permutation test.
 *
 * Formula: MDE_d ≈ sqrt(2/n) × (z_{1−α/2} + z_{1−β})
 *
 * This is the normal-approximation formula for the minimum mean difference
 * detectable at the given false-positive rate α and power (1−β), expressed in
 * units of pooled standard deviation (Cohen's d).  For binary data with
 * σ_pooled ≈ 0.5 this translates directly.
 *
 * The calibration suite (calibration.test.ts) verifies that injecting exactly
 * this MDE produces detection at ≥ the claimed power, and injecting less does
 * not.
 *
 * @param nPerCondition  observations per group
 * @param alpha          nominal false-positive rate (default 0.05)
 * @param power          desired power (default 0.80)
 */
export function computeMDE(
  nPerCondition: number,
  alpha = 0.05,
  power = 0.80
): number {
  // Standard normal quantiles via a minimax rational approximation of Φ⁻¹.
  // Accurate to ±2×10⁻³ in the range p ∈ (0.01, 0.99) — sufficient for MDE.
  function invNorm(p: number): number {
    // Rational approximation (Abramowitz & Stegun 26.2.17)
    const t = Math.sqrt(-2 * Math.log(p < 0.5 ? p : 1 - p))
    const c0 = 2.515517, c1 = 0.802853, c2 = 0.010328
    const d1 = 1.432788, d2 = 0.189269, d3 = 0.001308
    const approx = t - (c0 + c1 * t + c2 * t * t) / (1 + d1 * t + d2 * t * t + d3 * t * t * t)
    return p < 0.5 ? -approx : approx
  }

  const zAlpha = invNorm(1 - alpha / 2)  // two-sided critical value
  const zBeta  = invNorm(power)

  return Math.sqrt(2 / nPerCondition) * (zAlpha + zBeta)
}

// ── Main permutation test ─────────────────────────────────────────────────────

/**
 * §5.2 / §9.1.1 — Permutation test for k groups of equal length n.
 *
 * groups[g][k] = observation from condition g in period k.
 * All groups must have the same length (n periods).
 *
 * See module-level comments for the permutation scheme and statistical rationale.
 *
 * @param groups        2-D array: groups[conditionIndex][periodIndex]
 * @param seed          PRNG seed — same seed → same result
 * @param nPermutations number of random permutations (default 1000)
 * @param alpha         nominal α for MDE calculation (default 0.05)
 * @param power         target power for MDE calculation (default 0.80)
 */
export function permutationTest(
  groups: readonly (readonly number[])[],
  seed: number,
  nPermutations = 1000,
  alpha = 0.05,
  power = 0.80
): PermutationTestResult {
  if (groups.length < 2) throw new Error('permutationTest requires at least 2 groups')
  const n = groups[0].length
  for (const g of groups) {
    if (g.length !== n) throw new Error('all groups must have the same length (n periods)')
  }

  const rng = mkRng(seed)
  const k = groups.length

  // Observed test statistic
  const tObs = maxPairwiseMeanDiff(groups)

  // Working arrays for the permuted period values (one slot per condition)
  // period_values[k] = the k values for period k across all conditions
  const periodValues: number[][] = []
  for (let t = 0; t < n; t++) {
    periodValues.push(groups.map(g => g[t]))
  }

  // Permuted means accumulator
  const permMeans: number[] = new Array(k).fill(0)

  let countGte = 0

  for (let p = 0; p < nPermutations; p++) {
    // Reset permuted sums
    const sums = new Array(k).fill(0)

    for (let t = 0; t < n; t++) {
      // Shuffle this period's values across conditions
      const pv = periodValues[t].slice()  // copy
      shuffleInPlace(pv, rng)
      for (let g = 0; g < k; g++) sums[g] += pv[g]
    }

    // Compute max pairwise mean difference for this permutation
    let tPerm = 0
    for (let i = 0; i < k; i++) {
      const mi = sums[i] / n
      for (let j = i + 1; j < k; j++) {
        const diff = Math.abs(mi - sums[j] / n)
        if (diff > tPerm) tPerm = diff
      }
    }

    if (tPerm >= tObs) countGte++
  }

  // p = (1 + count) / (nPermutations + 1) — counts observed itself as one permutation
  const pValue = (1 + countGte) / (nPermutations + 1)
  const effectSize = maxCohenD(groups)
  const mde = computeMDE(n, alpha, power)

  return {
    pValue,
    effectSize,
    observedStatistic: tObs,
    nPermutations,
    minimumDetectableEffect: mde,
    seed,
  }
}

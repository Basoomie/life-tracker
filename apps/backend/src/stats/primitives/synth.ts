// §9.6 Structural requirement 3 — Synthetic data generator.
//
// First-class component of the codebase, not throwaway test scaffolding.
// Produces realistic habit-like observation sequences for calibrating the
// statistical primitives in permutation.ts.
//
// ── Tunable dimensions ───────────────────────────────────────────────────────
//   effectSize       Cohen's d between best and worst condition; 0 = no effect
//   autocorrelation  ρ ∈ [0, 1); 0 = i.i.d.; 0.5 = moderate streakiness
//   nConditions      number of groups (e.g. 7 for day-of-week)
//   nPerCondition    observations per group (e.g. 10 weeks)
//   baseRate         base success probability for binary (default 0.5)
//   shape            'binary' | 'continuous_percentage' | 'continuous_duration'
//   seed             fully reproducible
//
// ── Single-chain model (the correct model for within-period permutation) ─────
// The real use case: one habit measured for N = nConditions × nPerCondition
// total days. Condition is determined by the day's position within a period
// (e.g., day-of-week: day 0→Mon, day 1→Tue, …). Autocorrelation runs along
// the full single sequence — consecutive days are correlated regardless of
// which condition they fall into.
//
// This is the ONLY model for which within-period permutation correctly controls
// the false-positive rate under autocorrelation:
//   • Within each period k, the nConditions consecutive values all come from
//     the same chain and are thus identically distributed under the null.
//   • Swapping them within the period is valid (marginals are the same).
//   • Between-period autocorrelation is preserved across all permutations,
//     so the null distribution correctly reflects the inflated variance that
//     autocorrelation induces in the group means.
//
// With INDEPENDENT chains per condition (the wrong model): shuffling period-k
// values mixes observations from different chains, destroying the within-chain
// autocorrelation and producing a null distribution that is too narrow — leading
// to inflated false-positive rates.
//
// ── Autocorrelation mechanism (binary) ───────────────────────────────────────
// First-order Markov carry-over: the chain state is binary (0/1) and at each
// step the transition depends on the NEXT condition's base rate p_g and ρ:
//
//   P(success | prev=1, condition g) = p_g + ρ(1 − p_g)   [persistence]
//   P(success | prev=0, condition g) = p_g × (1 − ρ)       [return]
//
// Under the null (equal p_g), this reduces to a standard binary Markov chain
// with stationary mean p and lag-1 autocorrelation exactly ρ.  The chain is
// time-reversible (detailed balance holds), making within-period swaps valid.
//
// ── Autocorrelation mechanism (continuous) ───────────────────────────────────
// Fixed-effects AR(1): x_t = mean_g(t) + residual_t, where residual is AR(1)
// with autocorrelation ρ.  Under the null (equal means) this is a standard
// AR(1) process with autocorrelation exactly ρ.
//
// ── Effect size ──────────────────────────────────────────────────────────────
// Conditions are linearly spaced in mean: condition 0 = highest, last = lowest.
// For binary:  spread = effectSize × σ, where σ = sqrt(baseRate(1−baseRate)).
// Cohen's d between best and worst ≈ effectSize (exact when σ_pooled = σ).

export type SynthShape = 'binary' | 'continuous_percentage' | 'continuous_duration'

export type SynthOptions = {
  nConditions: number       // number of groups
  nPerCondition: number     // observations per group (= number of periods)
  effectSize: number        // Cohen's d between best and worst condition; 0 = null
  autocorrelation: number   // ρ ∈ [0, 1)
  baseRate?: number         // base success probability or mean (default 0.5)
  shape?: SynthShape        // default 'binary'
  seed: number
}

export type SynthDataset = {
  groups: number[][]            // groups[conditionIndex][periodIndex]
  options: Required<SynthOptions>
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

// ── Per-condition base rate ───────────────────────────────────────────────────
function conditionBaseRates(
  nConditions: number,
  effectSize: number,
  baseRate: number,
  shape: SynthShape
): number[] {
  if (nConditions === 1) return [baseRate]

  let sigma: number
  if (shape === 'binary') {
    sigma = Math.sqrt(baseRate * (1 - baseRate))
  } else if (shape === 'continuous_percentage') {
    sigma = 20
  } else {
    sigma = 30
  }

  const totalSpread = effectSize * sigma
  const rates: number[] = []
  for (let g = 0; g < nConditions; g++) {
    const offset = totalSpread * (1 - (2 * g) / (nConditions - 1)) / 2
    let r = baseRate + offset
    if (shape === 'binary') r = Math.max(0.02, Math.min(0.98, r))
    else if (shape === 'continuous_percentage') r = Math.max(0, Math.min(100, r))
    else r = Math.max(0, r)
    rates.push(r)
  }
  return rates
}

// ── Box-Muller normal sampler ─────────────────────────────────────────────────
function makeNormalSampler(epsStd: number, rng: () => number): () => number {
  return function sampleNormal(): number {
    const u1 = Math.max(1e-10, rng())
    const u2 = rng()
    return epsStd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  }
}

// ── Single-chain binary generator ────────────────────────────────────────────
// Generates N observations as one Markov chain; condition assignment is
// t % nConditions, and transition probabilities are condition-specific.
// Under the null (all rates equal) this is a standard binary Markov chain
// with lag-1 autocorrelation exactly ρ.

function generateSingleChainBinary(
  N: number,
  rates: number[],
  rho: number,
  rng: () => number
): number[] {
  const nConditions = rates.length
  const seq: number[] = []

  // Initialise at stationary distribution of first condition
  const g0 = 0 % nConditions
  let prev = rng() < rates[g0] ? 1 : 0
  seq.push(prev)

  for (let t = 1; t < N; t++) {
    const g = t % nConditions
    const pBase = rates[g]
    const pPersist = pBase + rho * (1 - pBase)
    const pReturn  = pBase * (1 - rho)
    prev = rng() < (prev === 1 ? pPersist : pReturn) ? 1 : 0
    seq.push(prev)
  }
  return seq
}

// ── Single-chain continuous generator ────────────────────────────────────────
// Fixed-effects AR(1): x_t = mean_g(t) + residual_t.
// Residuals follow a zero-mean AR(1) with autocorrelation ρ.

function generateSingleChainContinuous(
  N: number,
  rates: number[],
  sigma: number,
  rho: number,
  rng: () => number,
  clampMin: number,
  clampMax: number
): number[] {
  const nConditions = rates.length
  const epsStd = sigma * Math.sqrt(1 - rho * rho)
  const sampleNormal = makeNormalSampler(epsStd, rng)

  const seq: number[] = []
  let residual = 0  // start at stationary mean of residual process

  for (let t = 0; t < N; t++) {
    const g = t % nConditions
    const val = rates[g] + residual
    seq.push(Math.max(clampMin, Math.min(clampMax, val)))
    residual = rho * residual + sampleNormal()
  }
  return seq
}

// ── Main generator ────────────────────────────────────────────────────────────

export function generateSynthData(options: SynthOptions): SynthDataset {
  const {
    nConditions,
    nPerCondition,
    effectSize,
    autocorrelation,
    seed,
  } = options
  const baseRate = options.baseRate ?? 0.5
  const shape = options.shape ?? 'binary'

  if (nConditions < 1) throw new Error('nConditions must be ≥ 1')
  if (nPerCondition < 1) throw new Error('nPerCondition must be ≥ 1')
  if (autocorrelation < 0 || autocorrelation >= 1) throw new Error('autocorrelation must be in [0, 1)')
  if (effectSize < 0) throw new Error('effectSize must be ≥ 0')

  const rng = mkRng(seed)
  const rates = conditionBaseRates(nConditions, effectSize, baseRate, shape)
  const N = nConditions * nPerCondition

  // Generate one chain of length N; condition at time t is t % nConditions.
  let chain: number[]
  if (shape === 'binary') {
    chain = generateSingleChainBinary(N, rates, autocorrelation, rng)
  } else if (shape === 'continuous_percentage') {
    chain = generateSingleChainContinuous(N, rates, 20, autocorrelation, rng, 0, 100)
  } else {
    chain = generateSingleChainContinuous(N, rates, 30, autocorrelation, rng, 0, Infinity)
  }

  // Split into groups: groups[g][k] = chain[k * nConditions + g]
  const groups: number[][] = Array.from({ length: nConditions }, () => [])
  for (let t = 0; t < N; t++) {
    groups[t % nConditions].push(chain[t])
  }

  return {
    groups,
    options: { ...options, baseRate, shape },
  }
}

// ── Measurement functions (for generator self-tests) ─────────────────────────

/**
 * Compute lag-1 autocorrelation of a univariate series.
 * Returns 0 for series of length < 2 or zero variance.
 */
export function measureLag1Autocorrelation(series: readonly number[]): number {
  const n = series.length
  if (n < 2) return 0

  const mean = series.reduce((s, x) => s + x, 0) / n
  let num = 0
  let den = 0
  for (let t = 0; t < n - 1; t++) {
    num += (series[t] - mean) * (series[t + 1] - mean)
    den += (series[t] - mean) ** 2
  }
  den += (series[n - 1] - mean) ** 2
  return den === 0 ? 0 : num / den
}

/**
 * Compute max pairwise Cohen's d across all group pairs.
 * Uses pooled standard deviation. Returns 0 for single-group input.
 */
export function measureMaxCohenD(groups: readonly (readonly number[])[]): number {
  if (groups.length < 2) return 0

  function mean(arr: readonly number[]): number {
    return arr.reduce((s, x) => s + x, 0) / arr.length
  }
  function variance(arr: readonly number[]): number {
    const m = mean(arr)
    return arr.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, arr.length - 1)
  }
  function pooledStd(a: readonly number[], b: readonly number[]): number {
    const na = a.length, nb = b.length
    const pooledVar = ((na - 1) * variance(a) + (nb - 1) * variance(b)) / (na + nb - 2)
    return Math.sqrt(Math.max(0, pooledVar))
  }

  let maxD = 0
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const s = pooledStd(groups[i], groups[j])
      if (s === 0) continue
      const d = Math.abs(mean(groups[i]) - mean(groups[j])) / s
      if (d > maxD) maxD = d
    }
  }
  return maxD
}

// §5.2 / §9.6 — Power measurement and analytical power functions.
//
// PURE FUNCTIONS ONLY.  Zero domain knowledge — no DB, no event replay, no
// occurrence/item/day-start concepts.  This is the statistics side of §9.1.1's
// observation-array seam.
//
// ── Two approaches ────────────────────────────────────────────────────────────
//
// 1. measurePermutationPower — empirical power for permutation tests (k=2, k=7).
//    Uses generateSynthData + permutationTest from step 2a.  Always runs at
//    d=0.8 (the "smallest interesting effect" per §5.2) with the observed n and
//    estimated ρ.  Seeded so same inputs → same result.  ~200 reps keeps it
//    under 200 ms for practical n values.
//
// 2. Analytical power functions for direct estimators:
//    - analyticPowerLag1 — lag-1 autocorrelation (Z-test approximation)
//    - analyticMDELag1   — MDE for lag-1 autocorrelation
//    - rayleighPower     — Rayleigh test power for circular variance
//    - rayleighMDE       — MDE for circular variance (Rayleigh test)
//    - regressionPower   — OLS slope power (t-test approximation)
//    - regressionMDE     — MDE for regression slope
//
// These are the correct estimators per §5.3.1 Finding F:
//   "not every insight uses a permutation test, and this is the most consequential
//    result" of calibration.

import { generateSynthData } from './synth'
import { permutationTest } from './permutation'

// ── Shared normal distribution utilities ──────────────────────────────────────

// Standard normal CDF via Abramowitz & Stegun rational approximation 26.2.17.
// Accurate to |error| < 7.5×10⁻⁸ across the real line.
export function normalCDF(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const poly = t * (0.319381530
    + t * (-0.356563782
    + t * (1.781477937
    + t * (-1.821255978
    + t * 1.330274429))))
  const p = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z) * poly
  return z >= 0 ? p : 1 - p
}

// Inverse normal CDF via rational approximation (Abramowitz & Stegun 26.2.17).
// Accurate to ±2×10⁻³ for p ∈ (0.01, 0.99) — sufficient for power/MDE formulas.
export function invNorm(p: number): number {
  const t = Math.sqrt(-2 * Math.log(p < 0.5 ? p : 1 - p))
  const c0 = 2.515517, c1 = 0.802853, c2 = 0.010328
  const d1 = 1.432788, d2 = 0.189269, d3 = 0.001308
  const approx = t - (c0 + c1 * t + c2 * t * t) /
    (1 + d1 * t + d2 * t * t + d3 * t * t * t)
  return p < 0.5 ? -approx : approx
}

// ── Empirical permutation test power ─────────────────────────────────────────

const POWER_BASE_SEED = 42_000_000

/**
 * Measure power of the within-period permutation test empirically.
 *
 * Runs nReps synthetic datasets at (k, nPerCondition, d=0.8, rho), counts
 * how many times p ≤ α, returns the fraction.  Same seed → same result.
 *
 * @param k              number of conditions (2 or 7)
 * @param nPerCondition  observations per condition (= number of periods/weeks)
 * @param rho            estimated lag-1 autocorrelation from the real data
 * @param nReps          number of synthetic replicates (default 200)
 * @param nPermutations  permutations per test (default 500)
 * @param alpha          nominal α (default 0.05)
 * @param targetD        effect size to test power at (default 0.8 per §5.2)
 */
export function measurePermutationPower(
  k: number,
  nPerCondition: number,
  rho: number,
  nReps = 200,
  nPermutations = 500,
  alpha = 0.05,
  targetD = 0.8
): number {
  if (nPerCondition < 1) return 0
  // Clamp rho to the generator's valid range
  const safeRho = Math.max(0, Math.min(0.99, rho))

  let detected = 0
  for (let i = 0; i < nReps; i++) {
    const data = generateSynthData({
      nConditions: k,
      nPerCondition,
      effectSize: targetD,
      autocorrelation: safeRho,
      baseRate: 0.7,
      shape: 'binary',
      seed: POWER_BASE_SEED + i,
    })
    const result = permutationTest(data.groups, POWER_BASE_SEED + nReps + i, nPermutations, alpha)
    if (result.pValue <= alpha) detected++
  }
  return detected / nReps
}

// ── Lag-1 autocorrelation power (§5.3 item 5) ────────────────────────────────

/**
 * Analytical power for the lag-1 autocorrelation Z-test.
 * H₀: ρ=0, H₁: |ρ| ≥ rhoMin.
 * Under H₁, Z = r × √n ~ N(rhoMin × √n, 1) approximately.
 * Power = Φ(rhoMin × √n − z_{α/2})  [positive tail only; symmetric for negative]
 *
 * @param n      length of the time series
 * @param rhoMin minimum interesting |ρ| (default 0.28 per §5.3 — detectable in ~7 weeks)
 * @param alpha  nominal α (default 0.05)
 */
export function analyticPowerLag1(n: number, rhoMin = 0.28, alpha = 0.05): number {
  if (n < 2) return 0
  const zAlpha2 = invNorm(1 - alpha / 2)
  return normalCDF(rhoMin * Math.sqrt(n) - zAlpha2)
}

/**
 * Analytical MDE for the lag-1 autocorrelation Z-test.
 * Minimum |ρ| detectable at the given power.
 */
export function analyticMDELag1(n: number, alpha = 0.05, power = 0.80): number {
  if (n < 2) return 1  // sentinel: nothing detectable at n < 2
  const zAlpha2 = invNorm(1 - alpha / 2)
  const zBeta   = invNorm(power)
  return (zAlpha2 + zBeta) / Math.sqrt(n)
}

// ── Rayleigh test power for circular variance (§5.3 item 2 — context stability) ─

// The Rayleigh test for uniformity: H₀ = uniform timing, H₁ = concentrated timing.
// Test statistic Z = 2nR̄² ~ χ²(2) under H₀ (approximately).
// Under H₁ with mean resultant length ρ_R:
//   √(2n) × R̄ ~ N(√(2n) × ρ_R, 1) approximately.
//   Power ≈ Φ(√(2n) × ρ_R − z_α_rayleigh)
// where z_α_rayleigh = √(χ²_{2,α}) = √(−2 ln α) for large n.
//
// The "effect" for context stability is CONCENTRATION (low circularVariance):
//   circularVariance = 1 − R̄, so ρ_R = 1 − circularVariance.
// High concentration (small V, large R̄) → high power to detect non-uniform timing.

function rayleighCritical(alpha: number): number {
  // Critical value for Rayleigh test: Z_crit = √χ²_{2,α} = √(−2 ln α)
  return Math.sqrt(-2 * Math.log(alpha))
}

/**
 * Rayleigh test power for context stability.
 * circularVariance ∈ [0,1]: 0 = maximally concentrated, 1 = uniform spread.
 * Power = P(detect non-uniform timing | observed circularVariance, n sessions).
 */
export function rayleighPower(nSessions: number, circularVariance: number, alpha = 0.05): number {
  if (nSessions < 2) return 0
  const rBar = 1 - circularVariance          // mean resultant length
  const zCrit = rayleighCritical(alpha)      // √χ²_{2,α}
  // Power ≈ Φ(√(2n) × R̄ − z_crit)
  return normalCDF(Math.sqrt(2 * nSessions) * rBar - zCrit)
}

/**
 * Rayleigh MDE for context stability.
 * Returns the minimum circular variance V such that we have `power` probability
 * of detecting it as non-uniform (i.e., the maximum V below which we'd reliably
 * conclude the habit's timing is consistent).
 *
 * MDE_R̄ = (z_crit + z_β) / √(2n)
 * MDE_V  = 1 − MDE_R̄  (convert from mean-resultant to circular-variance space)
 */
export function rayleighMDE(nSessions: number, alpha = 0.05, power = 0.80): number {
  if (nSessions < 2) return 0  // nothing detectable; 0 means "maximally concentrated" is MDE
  const zCrit = rayleighCritical(alpha)
  const zBeta = invNorm(power)
  const mdeRBar = (zCrit + zBeta) / Math.sqrt(2 * nSessions)
  // Convert: circularVariance = 1 − R̄_min (clamp so MDE ∈ [0, 1])
  return Math.max(0, Math.min(1, 1 - mdeRBar))
}

// ── Regression / trajectory power ────────────────────────────────────────────

/**
 * Analytical power for OLS regression slope test.
 * Uses the t-test approximation via normal distribution (valid for n ≥ 5 months).
 *
 * For equally-spaced x: SSxx = n(n²−1)/12.
 * SE(slope) = residualSD / √SSxx.
 * Power ≈ Φ(|slope| / SE(slope) − z_{α/2}).
 *
 * @param nMonths    number of monthly data points (= n in the regression)
 * @param slope      observed OLS slope (adherence/month)
 * @param residualSD observed residual standard deviation
 * @param alpha      nominal α (default 0.05)
 */
export function regressionPower(
  nMonths: number,
  slope: number,
  residualSD: number,
  alpha = 0.05
): number {
  if (nMonths < 2 || residualSD === 0) return 0
  // SSxx for equally-spaced months 0, 1, ..., n-1
  const SSxx = nMonths * (nMonths * nMonths - 1) / 12
  const seSlope = residualSD / Math.sqrt(SSxx)
  const zAlpha2 = invNorm(1 - alpha / 2)
  const ncp = Math.abs(slope) / seSlope
  return normalCDF(ncp - zAlpha2)
}

/**
 * Analytical MDE for OLS regression slope.
 * Minimum |slope| detectable at the given power.
 * Uses residualSD from the data (if not yet fitted, caller provides an assumed value).
 *
 * @param nMonths    number of monthly data points
 * @param residualSD assumed or observed residual SD
 * @param alpha      nominal α
 * @param power      target power (default 0.80)
 */
export function regressionMDE(
  nMonths: number,
  residualSD: number,
  alpha = 0.05,
  power = 0.80
): number {
  if (nMonths < 2) return Infinity
  const SSxx = nMonths * (nMonths * nMonths - 1) / 12
  const seSlope = residualSD / Math.sqrt(SSxx)
  const zAlpha2 = invNorm(1 - alpha / 2)
  const zBeta   = invNorm(power)
  return (zAlpha2 + zBeta) * seSlope
}

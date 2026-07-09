// §5.3 Trajectory — OLS regression primitive.
//
// PURE FUNCTION.  Zero domain knowledge.  Statistics side of §9.1.1 seam.
//
// Input: paired (x, y) arrays where x = month index (0, 1, 2, …) and
// y = adherence rate ∈ [0, 1].
//
// Output: slope, intercept, R², residual SD, and a p-value for H₀: slope = 0.
// p-value uses the normal approximation to the t(n−2) distribution (sufficient
// for n ≥ 5 months; conservative for smaller n — no issues since we report
// power alongside p-value and the user can judge).

import { normalCDF } from './power'

export type OLSResult = {
  slope: number
  intercept: number
  rSquared: number
  residualSD: number   // √(SS_res / (n − 2)); 0 when n ≤ 2
  pValue: number       // two-tailed, H₀: slope = 0
  nObs: number
}

/**
 * Fit a simple OLS regression y ~ x and return slope, intercept, R², residualSD,
 * and a two-tailed p-value for H₀: slope = 0.
 *
 * Requires n ≥ 2; throws for n < 2 or mismatched lengths.
 */
export function olsRegression(x: readonly number[], y: readonly number[]): OLSResult {
  const n = x.length
  if (y.length !== n) throw new Error('olsRegression: x and y must have the same length')
  if (n < 2) throw new Error('olsRegression: requires at least 2 data points')

  const xMean = x.reduce((s, v) => s + v, 0) / n
  const yMean = y.reduce((s, v) => s + v, 0) / n

  let Sxx = 0, Sxy = 0, Syy = 0
  for (let i = 0; i < n; i++) {
    const dx = x[i] - xMean
    const dy = y[i] - yMean
    Sxx += dx * dx
    Sxy += dx * dy
    Syy += dy * dy
  }

  if (Sxx === 0) {
    // All x values identical — slope undefined; return flat line at yMean
    return { slope: 0, intercept: yMean, rSquared: 0, residualSD: 0, pValue: 1, nObs: n }
  }

  const slope = Sxy / Sxx
  const intercept = yMean - slope * xMean

  let ssRes = 0
  for (let i = 0; i < n; i++) {
    const residual = y[i] - (intercept + slope * x[i])
    ssRes += residual * residual
  }

  // Syy=0 means all y are identical — no variance to explain; R² = 0 by convention
  const rSquared = Syy === 0 ? 0 : Math.max(0, 1 - ssRes / Syy)
  const residualSD = n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0

  // t = slope / SE(slope), SE = residualSD / √Sxx
  // Under H₀, t ~ t(n−2); approximate with N(0,1) (conservative at small n)
  let pValue = 1
  if (residualSD > 0) {
    const seSlope = residualSD / Math.sqrt(Sxx)
    const tStat = slope / seSlope
    // Two-tailed p-value via normal approximation
    pValue = 2 * (1 - normalCDF(Math.abs(tStat)))
  }

  return { slope, intercept, rSquared, residualSD, pValue, nObs: n }
}

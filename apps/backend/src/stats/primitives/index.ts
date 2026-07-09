// §9.1.1 — Statistics-side barrel export.
// Pure functions from observation arrays to statistics; zero domain knowledge.
export { generateSynthData, measureLag1Autocorrelation, measureMaxCohenD } from './synth'
export type { SynthOptions, SynthDataset, SynthShape } from './synth'
export { permutationTest, maxCohenD, computeMDE } from './permutation'
export type { PermutationTestResult } from './permutation'
export {
  normalCDF,
  invNorm,
  measurePermutationPower,
  analyticPowerLag1,
  analyticMDELag1,
  rayleighPower,
  rayleighMDE,
  regressionPower,
  regressionMDE,
} from './power'
export { olsRegression } from './regression'
export type { OLSResult } from './regression'

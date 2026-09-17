// §6.6 — Bucket tiling and seam rules.
//
// The rules themselves live in @tracker/shared (packages/shared/src/domain/buckets.ts)
// because the settings UI previews the same decisions the API enforces, and two copies
// of "is this bucket set valid" would drift. This module is the backend's re-export so
// route code keeps importing its domain rules from ../domain, like every other route.

export {
  isHHMM,
  buildBucketCycle,
  validateBucketTiling,
  validateSeamMove,
  applySeamMove,
  planDayStartReanchor,
} from '@tracker/shared'

export type { BucketSeam, BucketCycle, ReanchorPlan } from '@tracker/shared'

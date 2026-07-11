// §5.1 amendment — recurring items need an explicit start day, distinct from the
// row's created_at timestamp. Previously the recurrence anchor (used by 'interval'
// and 'monthly' rules to decide which days are due) was always the item's creation
// date, with no way for the user to choose a different start day at creation time.
//
// NULL means "fall back to created_at's date" (every pre-existing item, and any
// new item created without an explicit choice) — see itemAnchorDate() in
// packages/shared/src/domain/recurrence.ts. This preserves prior behavior exactly
// for anything that doesn't opt in.

export const name = '0012_item_anchor_day'

export const up = `
ALTER TABLE items ADD COLUMN anchor_day DATE;
`

export const down = `
ALTER TABLE items DROP COLUMN IF EXISTS anchor_day;
`

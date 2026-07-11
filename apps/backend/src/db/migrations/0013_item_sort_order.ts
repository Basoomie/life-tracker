// Manual child ordering (drag-and-drop). Lives directly on items, mirroring
// priority — a live mutable field, not part of ItemSnapshot, so a reorder
// applies to every day immediately rather than waiting for the next
// materialization (see enrichOccurrence's hasChildren for the same pattern).
//
// DEFAULT 0 ties every pre-existing item — findChildItems's
// ORDER BY sort_order, created_at falls back to today's creation-order
// display until a user actually drags something.

export const name = '0013_item_sort_order'

export const up = `
ALTER TABLE items ADD COLUMN sort_order SMALLINT NOT NULL DEFAULT 0;
`

export const down = `
ALTER TABLE items DROP COLUMN IF EXISTS sort_order;
`

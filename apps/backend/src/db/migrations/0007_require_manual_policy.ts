// §8.1 — Add 'require_manual' to the disposition_policy CHECK constraint.
//
// The spec lists four end-of-day policies: skip / excuse / auto_close / require_manual.
// The initial schema only encoded three; this migration extends it.
//
// Postgres doesn't support ALTER TABLE ... MODIFY CHECK; instead we drop the
// auto-generated constraint (found by name pattern in pg_constraint) and add a
// new named one.

export const name = '0007_require_manual_policy'

export const up = `
DO $$
DECLARE
  cname TEXT;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'items'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%disposition_policy%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE items DROP CONSTRAINT %I', cname);
  END IF;
END;
$$;

ALTER TABLE items
  ADD CONSTRAINT items_disposition_policy_check
    CHECK (disposition_policy IN ('skip', 'excuse', 'auto_close', 'require_manual'));
`

export const down = `
DO $$
DECLARE
  cname TEXT;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'items'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%disposition_policy%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE items DROP CONSTRAINT %I', cname);
  END IF;
END;
$$;

ALTER TABLE items
  ADD CONSTRAINT items_disposition_policy_check
    CHECK (disposition_policy IN ('skip', 'excuse', 'auto_close'));
`

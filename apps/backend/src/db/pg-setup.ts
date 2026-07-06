// Configure pg type parsers before any pool is created.
// Called once at module load in db.ts and migrate.ts.
//
// By default pg converts DATE columns to JavaScript Date objects using local
// timezone — producing results like 2024-01-01T07:00:00.000Z on UTC-7 machines
// instead of the plain string '2024-01-01'.  Overriding OID 1082 returns the raw
// ISO date string that the domain types expect.
import pg from 'pg'

pg.types.setTypeParser(1082 /* DATE */, (val: string) => val)

import * as m1 from './0001_users'
import * as m2 from './0002_categories_reasons'
import * as m3 from './0003_buckets_day_start'
import * as m4 from './0004_items'
import * as m5 from './0005_occurrences'
import * as m6 from './0006_events'
import * as m7 from './0007_require_manual_policy'
import * as m8 from './0008_user_preferences'

export interface Migration {
  name: string
  up: string
  down: string
}

// Order matters: migrations run in this order (up) and reverse (down)
export const migrations: Migration[] = [m1, m2, m3, m4, m5, m6, m7, m8]

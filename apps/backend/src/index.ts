import { config } from 'dotenv'
import { join } from 'path'

// Load .env from project root when running locally outside Docker
config({ path: join(__dirname, '../../../.env') })

import { buildApp } from './app'
import { migrateUp } from './db/migrate'
import { bootstrap } from './db/bootstrap'
import { pool } from './db'
import { startScheduler } from './scheduler'

const port = parseInt(process.env.PORT ?? '3000', 10)

async function main() {
  await migrateUp(pool)
  await bootstrap(pool)  // §13.1: create initial user if table is empty
  const app = await buildApp()
  await app.listen({ port, host: '0.0.0.0' })
  startScheduler(pool)  // §8.4/v2 §9.3: daily materialization/dispositions/reviews
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

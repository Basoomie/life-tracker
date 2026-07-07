import { config } from 'dotenv'
import { join } from 'path'

// Load .env from project root when running locally outside Docker
config({ path: join(__dirname, '../../../.env') })

import { buildApp } from './app'
import { migrateUp } from './db/migrate'
import { seed } from './db/seed'
import { pool } from './db'

const port = parseInt(process.env.PORT ?? '3000', 10)

async function main() {
  await migrateUp(pool)
  await seed(pool)
  const app = await buildApp()
  await app.listen({ port, host: '0.0.0.0' })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

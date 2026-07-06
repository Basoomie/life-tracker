import { config } from 'dotenv'
import { join } from 'path'

// Load .env from project root when running locally outside Docker
config({ path: join(__dirname, '../../../.env') })

import { buildApp } from './app'

const port = parseInt(process.env.PORT ?? '3000', 10)

buildApp()
  .then((app) => app.listen({ port, host: '0.0.0.0' }))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })

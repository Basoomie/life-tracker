// Loaded via vitest setupFiles before each test file.
// Ensures .env is loaded when running tests outside Docker.
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../../../../../.env') })

import { access, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { setupCpa } from './setup-cpa.mjs'
const file = '.env'
let exists = false
try { await access(file); exists = true } catch (error) { if (error.code !== 'ENOENT') throw error }
if (exists) {
  console.log('.env already exists; its contents were preserved.')
  await setupCpa()
  process.exit(0)
}
const secret = () => randomBytes(24).toString('base64url')
const db = secret(), redis = secret(), admin = secret()
const lines = [
  'APP_URL=http://localhost:3000', 'APP_PORT=3000', 'BIND_ADDRESS=127.0.0.1',
  'ADMIN_USERNAME=admin', 'ADMIN_PASSWORD=' + admin,
  'APP_ENCRYPTION_KEY=' + randomBytes(32).toString('base64'),
  'POSTGRES_PASSWORD=' + db, 'REDIS_PASSWORD=' + redis,
  'DATABASE_URL=postgres://ccm:' + db + '@127.0.0.1:55432/commandcode',
  'REDIS_URL=redis://:' + redis + '@127.0.0.1:56379/0',
  'COMMANDCODE_API_URL=https://api.commandcode.ai/provider/v1',
  'COMMANDCODE_MANAGEMENT_URL=https://api.commandcode.ai', '',
]
await writeFile(file, lines.join('\n'), { mode: 0o600, flag: 'wx' })
console.log('Created .env with random credentials. Administrator username: admin. Read ADMIN_PASSWORD locally in .env.')
await setupCpa()

import { createError, defineEventHandler, readBody } from 'h3'
import { z } from 'zod'
import { publishUpdate } from '../../../lib/events'
import { deleteAccounts, setAccountsEnabled } from '../../../modules/logicc/store'
import { checkAccount } from '../../../modules/logicc/sync'
import { forgetToken } from '../../../modules/logicc/credentials'
import { signInAccount } from '../../../modules/logicc/login'
import { reconcileModuleBridge } from '../../../modules/bridge-maintenance'

/**
 * Bulk actions on Logicc accounts. `check` verifies credentials and refreshes
 * model catalogs now. `login` forces a fresh sign-in (ignoring the backoff) for
 * accounts with a stored password — use it after completing a verification.
 */
export default defineEventHandler(async event => {
  const parsed = z.object({ action: z.enum(['enable', 'disable', 'delete', 'check', 'login']), ids: z.array(z.string().uuid()).min(1).max(1000) }).strict().safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: '请选择账号和操作' })
  const { action, ids } = parsed.data
  let affected = 0
  const results: { id: string; ok: boolean; models: number; error: string | null }[] = []
  if (action === 'enable' || action === 'disable') affected = await setAccountsEnabled(ids, action === 'enable')
  else if (action === 'delete') {
    affected = await deleteAccounts(ids)
    await Promise.all(ids.map(id => forgetToken(id).catch(() => {})))
  } else if (action === 'login') {
    let index = 0
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (index < ids.length) {
        const id = ids[index++]!
        const outcome = await signInAccount(id, { ignoreBackoff: true }).catch(() => null)
        if (outcome?.ok) { const check = await checkAccount(id, { fresh: true }); results.push({ id, ok: check.ok, models: check.models, error: check.error }) }
        else results.push({ id, ok: false, models: 0, error: outcome ? (outcome as { message: string }).message : '账号没有可用于登录的邮箱密码' })
      }
    }))
    affected = results.filter(result => result.ok).length
  } else {
    let index = 0
    await Promise.all(Array.from({ length: Math.min(6, ids.length) }, async () => {
      while (index < ids.length) {
        const id = ids[index++]!
        results.push({ id, ...await checkAccount(id, { fresh: true }) })
      }
    }))
    affected = results.filter(result => result.ok).length
  }
  void reconcileModuleBridge('logicc').catch(() => {})
  await publishUpdate({ type: 'accounts' })
  return { action, affected, results }
})

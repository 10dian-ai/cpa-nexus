import { randomUUID } from 'node:crypto'
import { createError } from 'h3'
import type { Sql, TransactionSql } from 'postgres'
import { z } from 'zod'
import { getDb } from './db'
import { publishUpdate } from './events'
import type { GroupBinding, GroupModuleId, GroupView } from '../../shared/groups'

type Database = Sql | TransactionSql
export const groupIdsSchema = z.array(z.string().uuid()).min(1, '请至少选择一个分组')
export const groupInputSchema = z.object({ name: z.string().trim().min(1), description: z.string().optional(), enabled: z.boolean().optional() }).strict()
const emptyBinding = (): GroupBinding => ({ groupIds: [], groupNames: [] })
export async function getModuleDefaultGroupIds(sql: Database = getDb()): Promise<Record<GroupModuleId, string>> {
  const rows = await sql`SELECT module_id,group_id FROM nexus_module_group_defaults`
  const commandcode = rows.find(row => row.module_id === 'commandcode')?.group_id as string | undefined
  const cpa = rows.find(row => row.module_id === 'cpa')?.group_id as string | undefined
  if (!commandcode || !cpa) throw createError({ statusCode: 503, message: '模块默认分组尚未初始化，请完成数据库迁移' })
  return { commandcode, cpa }
}
export async function getModuleDefaultGroupId(moduleId: GroupModuleId, sql: Database = getDb()) {
  return (await getModuleDefaultGroupIds(sql))[moduleId]
}
export async function getDefaultModelKeyGroupIds(sql: Database = getDb()) {
  const defaults = await getModuleDefaultGroupIds(sql)
  return [...new Set([defaults.cpa, defaults.commandcode])]
}
export async function assertGroupIds(groupIds?: string[], sql: Database = getDb()): Promise<string[]> {
  const ids = [...new Set(groupIds ?? await getDefaultModelKeyGroupIds(sql))]
  if (!ids.length) throw createError({ statusCode: 400, message: '请至少选择一个分组' })
  const rows = await sql`SELECT id FROM nexus_groups WHERE id IN ${sql(ids)}`
  if (rows.length !== ids.length) throw createError({ statusCode: 400, message: '选择的分组不存在' })
  return ids
}
export async function setAccountGroups(sql: Database, moduleId: GroupModuleId, accountId: string, groupIds?: string[]) {
  const ids = await assertGroupIds(groupIds ?? [await getModuleDefaultGroupId(moduleId, sql)], sql)
  await sql`DELETE FROM nexus_account_groups WHERE module_id=${moduleId} AND account_id=${accountId}`
  for (const id of ids) await sql`INSERT INTO nexus_account_groups(module_id,account_id,group_id) VALUES(${moduleId},${accountId},${id})`
  return ids
}
export async function ensureAccountGroups(sql: Database, moduleId: GroupModuleId, accountId: string) {
  const defaultGroupId = await getModuleDefaultGroupId(moduleId, sql)
  await sql`INSERT INTO nexus_account_groups(module_id,account_id,group_id)
    SELECT ${moduleId},${accountId},${defaultGroupId}::uuid
    WHERE NOT EXISTS(SELECT 1 FROM nexus_account_groups WHERE module_id=${moduleId} AND account_id=${accountId}) ON CONFLICT DO NOTHING`
}
export async function setKeyGroups(sql: Database, keyId: string, groupIds?: string[]) {
  const ids = await assertGroupIds(groupIds, sql)
  await sql`DELETE FROM nexus_key_groups WHERE key_id=${keyId}`
  for (const id of ids) await sql`INSERT INTO nexus_key_groups(key_id,group_id) VALUES(${keyId},${id})`
  return ids
}
export async function accountGroupBindings(moduleId: GroupModuleId, accountIds?: string[], sql: Database = getDb()) {
  const map = new Map<string, GroupBinding>()
  if (accountIds?.length === 0) return map
  const filter = accountIds ? sql`AND ag.account_id IN ${sql(accountIds)}` : sql``
  const rows = await sql`SELECT ag.account_id,g.id,g.name FROM nexus_account_groups ag JOIN nexus_groups g ON g.id=ag.group_id
    WHERE ag.module_id=${moduleId} ${filter} ORDER BY g.created_at,g.id`
  for (const row of rows) { const entry = map.get(row.account_id) ?? emptyBinding(); entry.groupIds.push(row.id); entry.groupNames.push(row.name); map.set(row.account_id, entry) }
  return map
}
export async function keyGroupBindings(keyIds?: string[], sql: Database = getDb()) {
  const map = new Map<string, GroupBinding>()
  if (keyIds?.length === 0) return map
  const filter = keyIds ? sql`WHERE kg.key_id IN ${sql(keyIds)}` : sql``
  const rows = await sql`SELECT kg.key_id,g.id,g.name FROM nexus_key_groups kg JOIN nexus_groups g ON g.id=kg.group_id ${filter} ORDER BY g.created_at,g.id`
  for (const row of rows) { const entry = map.get(row.key_id) ?? emptyBinding(); entry.groupIds.push(row.id); entry.groupNames.push(row.name); map.set(row.key_id, entry) }
  return map
}
export async function resolveEnabledKeyGroupIds(keyId: string): Promise<string[]> {
  const rows = await getDb()`SELECT g.id FROM nexus_key_groups kg JOIN nexus_groups g ON g.id=kg.group_id
    JOIN gateway_keys k ON k.id=kg.key_id WHERE kg.key_id=${keyId} AND k.enabled=true AND g.enabled=true ORDER BY g.created_at,g.id`
  return rows.map(row => row.id)
}
export async function listGroups(): Promise<GroupView[]> {
  const rows = await getDb()`SELECT g.*,(SELECT count(*)::int FROM nexus_account_groups WHERE group_id=g.id) AS account_count,
    (SELECT count(*)::int FROM nexus_key_groups WHERE group_id=g.id) AS key_count FROM nexus_groups g ORDER BY g.is_default DESC,g.created_at,g.id`
  return rows.map(row => ({ id: row.id, name: row.name, description: row.description, enabled: row.enabled, isDefault: row.is_default,
    accountCount: row.account_count, keyCount: row.key_count, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }))
}
function groupStorageError(error: unknown): never {
  if ((error as { code?: string }).code === '23505') throw createError({ statusCode: 409, message: '分组名称已存在' })
  throw error
}
export async function createGroup(input: { name: string; description?: string; enabled?: boolean }) {
  const id = randomUUID()
  try { await getDb()`INSERT INTO nexus_groups(id,name,description,enabled) VALUES(${id},${input.name},${input.description ?? ''},${input.enabled ?? true})` }
  catch (error) { groupStorageError(error) }
  await publishUpdate({ type: 'groups' })
  return (await listGroups()).find(group => group.id === id)!
}
export async function patchGroup(id: string, input: { name?: string; description?: string; enabled?: boolean }) {
  let rows
  try { rows = await getDb()`UPDATE nexus_groups SET name=coalesce(${input.name ?? null},name),description=coalesce(${input.description ?? null},description),
    enabled=coalesce(${input.enabled ?? null},enabled),updated_at=now() WHERE id=${id} RETURNING id` }
  catch (error) { groupStorageError(error) }
  if (!rows.length) throw createError({ statusCode: 404, message: '分组不存在' })
  await publishUpdate({ type: 'groups' })
  return (await listGroups()).find(group => group.id === id)!
}
export async function deleteGroup(id: string) {
  const rows = await getDb()`SELECT is_default,EXISTS(SELECT 1 FROM nexus_module_group_defaults WHERE group_id=${id}) AS is_module_default FROM nexus_groups WHERE id=${id}`
  if (!rows.length) throw createError({ statusCode: 404, message: '分组不存在' })
  if (rows[0]!.is_module_default) throw createError({ statusCode: 409, message: '模块默认调用组不能删除，可以修改名称或管理其账号绑定' })
  if (rows[0]!.is_default) throw createError({ statusCode: 409, message: '默认分组不能删除' })
  try { await getDb()`DELETE FROM nexus_groups WHERE id=${id}` }
  catch (error) { if ((error as { code?: string }).code === '23503') throw createError({ statusCode: 409, message: '请先移走此分组绑定的账号和 API Key' }); throw error }
  await publishUpdate({ type: 'groups' })
}

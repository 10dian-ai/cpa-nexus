import { describe, expect, it } from 'vitest'
import { movePresetPrompt, parsePresetObject, parsePresetVariables, presetDocumentSettings, presetPromptOrderAmbiguous, presetPromptRows, presetSamplingKey, updatePresetPrompt } from '../app/composables/usePresetDocument'

describe('SillyTavern preset editing', () => {
  const prompts = [
    { identifier: 'main', name: '主提示词', content: 'Original', role: 'system', extension: { retained: true } },
    { identifier: 'jailbreak', name: '后置提示词', content: 'After history', role: 'system' },
  ]

  it('edits the global order and preserves other character settings', () => {
    const source = { prompts: structuredClone(prompts), prompt_order: [
      { character_id: 100001, order: [{ identifier: 'jailbreak', enabled: true }] },
      { character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }, { identifier: 'jailbreak', enabled: false }] },
    ] }
    const rows = presetPromptRows(source)
    expect(rows.map(row => row.identifier)).toEqual(['main', 'chatHistory', 'jailbreak'])
    updatePresetPrompt(source, rows[2]!, 'enabled', true)
    expect(source.prompt_order[1]!.order[2]!.enabled).toBe(true)
    expect(source.prompt_order[0]!.order).toEqual([{ identifier: 'jailbreak', enabled: true }])
    expect(source.prompts[0]!.extension).toEqual({ retained: true })
  })

  it('reorders a flat export without losing its history marker or extra fields', () => {
    const source: Record<string, unknown> = { prompts: structuredClone(prompts), prompt_order: [
      { identifier: 'main', enabled: true, retained: 'custom' },
      { identifier: 'chatHistory', enabled: true },
      { identifier: 'jailbreak', enabled: true },
    ] }
    expect(presetPromptOrderAmbiguous(source)).toBe(false)
    movePresetPrompt(source, 'jailbreak', -1)
    expect(source.prompt_order).toEqual([
      { identifier: 'main', enabled: true, retained: 'custom' },
      { identifier: 'jailbreak', enabled: true },
      { identifier: 'chatHistory', enabled: true },
    ])
  })

  it('keeps the implicit chat history when creating an editable order', () => {
    const source: Record<string, unknown> = { prompts: structuredClone(prompts) }
    expect(presetPromptRows(source).map(row => row.identifier)).toEqual(['main', 'chatHistory', 'jailbreak'])
    movePresetPrompt(source, 'jailbreak', -1)
    expect(source.prompt_order).toEqual([{ character_id: 100000, order: [
      { identifier: 'main', enabled: true }, { identifier: 'jailbreak', enabled: true }, { identifier: 'chatHistory', enabled: true },
    ] }])
  })

  it('preserves a nested export and edits its existing sampling alias', () => {
    const source = { metadata: { version: 'preserved' }, data: { prompts: structuredClone(prompts), temp_openai: 0.7 } }
    expect(presetSamplingKey(source, { key: 'temperature', aliases: ['temp_openai'] })).toBe('temp_openai')
    presetDocumentSettings(source).temp_openai = 0.9
    updatePresetPrompt(source, presetPromptRows(source)[0]!, 'content', 'Updated')
    expect(source.data.temp_openai).toBe(0.9)
    expect(source.data.prompts[0]!.content).toBe('Updated')
    expect(source.metadata).toEqual({ version: 'preserved' })
  })

  it('does not guess a character order or overwrite it during a move', () => {
    const source: Record<string, unknown> = { prompts: structuredClone(prompts), prompt_order: [
      { character_id: 100001, order: [{ identifier: 'main', enabled: true }] },
      { character_id: 100002, order: [{ identifier: 'jailbreak', enabled: true }] },
    ] }
    const original = structuredClone(source)
    expect(presetPromptOrderAmbiguous(source)).toBe(true)
    movePresetPrompt(source, 'main', 1)
    expect(source).toEqual(original)
  })

  it('rejects invalid pasted document and context variable shapes', () => {
    expect(() => parsePresetObject('[]')).toThrow('JSON 对象')
    expect(() => parsePresetVariables('{"char":42}')).toThrow('字符串')
    expect(parsePresetVariables('{"char":"角色名","description":"具体描述"}')).toEqual({ char: '角色名', description: '具体描述' })
  })
})

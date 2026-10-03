import { describe, expect, it } from 'vitest'
import { applyPreset, inspectPreset, parsePresetJson, validatePresetVariables } from '../server/lib/presets/engine'

const prompt = (id: string, content: string, extras: Record<string, unknown> = {}) => ({ identifier: id, role: 'system', content, ...extras })
const source = (prompts: Record<string, unknown>[], ids = prompts.map(p => String(p.identifier))) => ({ prompts, prompt_order: [{ character_id: 100000, order: ids.map(identifier => ({ identifier, enabled: true })) }] })
const preset = (sourceJson: Record<string, unknown>, variables = {}) => ({ sourceJson, variables })
const history = { identifier: 'chatHistory', marker: true }

describe('SillyTavern preset import and precise API transformations', () => {
  it('follows the global enabled order, includes post-history instructions, and preserves tools, images and all client controls', () => {
    const document = source([prompt('main', 'Begin'), history, prompt('jailbreak', 'End'), prompt('off', 'Disabled')])
    document.prompt_order[0]!.order.find(entry => entry.identifier === 'off')!.enabled = false
    Object.assign(document, { temperature: 0.5, openai_max_tokens: 256, openai_model: 'wrong', stream_openai: false })
    const messages = [{ role: 'system', content: 'Client system' }, { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }, { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'a', content: '{"ok":true}' }]
    const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }]
    const body = { model: 'client/model', stream: true, temperature: 1.2, tools, tool_choice: 'auto', max_completion_tokens: 99, messages }
    const result = applyPreset(preset(document), body, { protocol: 'chat' })
    expect(result).toMatchObject({ model: 'client/model', stream: true, temperature: 1.2, max_completion_tokens: 99, tool_choice: 'auto' })
    expect(result).not.toHaveProperty('max_tokens')
    expect(result.tools).toBe(tools)
    expect(result.messages).toEqual([{ role: 'system', content: 'Begin' }, ...messages, { role: 'system', content: 'End' }])
    expect((result.messages as any[])[2]).toBe(messages[1])
    expect(body.messages).toBe(messages)
  })

  it('inserts at depth zero, one and higher depths independently of relative order', () => {
    const document = source([history, prompt('zero', 'After', { injection_position: 1, injection_depth: 0 }), prompt('one', 'Before last', { injection_position: 1, injection_depth: 1 }), prompt('deep', 'At start', { injection_position: 1, injection_depth: 90 })])
    const messages = [{ role: 'user', content: 'First' }, { role: 'assistant', content: 'Answer' }, { role: 'user', content: 'Last' }]
    const result = applyPreset(preset(document), { messages }, { protocol: 'chat' })
    expect((result.messages as any[]).map(message => message.content)).toEqual(['At start', 'First', 'Answer', 'Before last', 'Last', 'After'])
  })

  it('groups depth injections by priority and role in forward wire order', () => {
    const document = source([history, prompt('s', 'S', { injection_position: 1, injection_depth: 0, injection_order: 100 }), prompt('u', 'U', { role: 'user', injection_position: 1, injection_depth: 0, injection_order: 100 }), prompt('a', 'A', { role: 'assistant', injection_position: 1, injection_depth: 0, injection_order: 100 }), prompt('low', 'Low', { injection_position: 1, injection_depth: 0, injection_order: 5 })])
    expect((applyPreset(preset(document), { messages: [] }, { protocol: 'chat' }).messages as any[]).map(message => message.content)).toEqual(['Low', 'A', 'U', 'S'])
  })

  it('never separates a tool call from its results when counting chat depth', () => {
    const document = source([history, prompt('injection', 'Inserted', { injection_position: 1, injection_depth: 1 })])
    const messages = [{ role: 'user', content: 'First' }, { role: 'assistant', tool_calls: [{ id: 'a' }] }, { role: 'tool', tool_call_id: 'a', content: 'Result' }]
    expect(applyPreset(preset(document), { messages }, { protocol: 'chat' }).messages).toEqual([messages[0], { role: 'system', content: 'Inserted' }, messages[1], messages[2]])
    const anthropic = [{ role: 'user', content: 'First' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'a' }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Result' }] }]
    const userPrompt = source([history, prompt('injection', 'Inserted', { role: 'user', injection_position: 1, injection_depth: 1 })])
    expect(applyPreset(preset(userPrompt), { messages: anthropic }, { protocol: 'messages' }).messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'First' }, { type: 'text', text: 'Inserted' }] }, anthropic[1], anthropic[2]])
  })

  it('requires actual role variables and expands last-message macros from text without modifying images', () => {
    const document = source([prompt('main', '{{char}} / {{user}} / {{lastUserMessage}}{{newline}}Done'), history])
    expect(inspectPreset(document).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing_variable' })]))
    const image = { type: 'image_url', image_url: { url: 'https://image.test' } }
    const result = applyPreset(preset(document, { char: 'C', user: 'U' }), { messages: [{ role: 'user', content: [{ type: 'text', text: 'Actual' }, image] }] }, { protocol: 'chat' })
    expect((result.messages as any[])[0].content).toBe('C / U / Actual\nDone')
    expect((result.messages as any[])[1].content[1]).toBe(image)
  })

  it('supports static role/world-info markers only with explicit data and renders format wrappers', () => {
    const document = { ...source([{ identifier: 'worldInfoBefore', marker: true }, { identifier: 'charPersonality', marker: true }, history]), wi_format: '[{0}]', personality_format: 'Traits: {{personality}}' }
    expect(inspectPreset(document).issues.filter(issue => issue.code === 'missing_marker_context')).toHaveLength(2)
    expect(applyPreset(preset(document), { messages: [] }, { protocol: 'chat' }).messages).toEqual([])
    expect(applyPreset(preset(document, { wiBefore: 'Lore', personality: 'Calm' }), { messages: [] }, { protocol: 'chat' }).messages).toEqual([{ role: 'system', content: '[Lore]' }, { role: 'system', content: 'Traits: Calm' }])
  })

  it('recognizes Prompt Manager exports, flat order and legacy main/jailbreak fields', () => {
    const wrapped = { version: 1, type: 'full', data: { prompts: [prompt('x', 'Custom'), history], prompt_order: [{ identifier: 'x', enabled: true }, { identifier: 'chatHistory', enabled: true }] } }
    expect(applyPreset(preset(wrapped), { messages: [] }, { protocol: 'chat' }).messages).toEqual([{ role: 'system', content: 'Custom' }])
    expect(applyPreset(preset({ main_prompt: 'Main', post_history_instructions: 'Tail' }), { messages: [{ role: 'user', content: 'History' }] }, { protocol: 'chat' }).messages).toEqual([{ role: 'system', content: 'Main' }, { role: 'user', content: 'History' }, { role: 'system', content: 'Tail' }])
  })

  it('uses global 100000 order and refuses to guess among character-specific orders', () => {
    const document = source([prompt('x', 'One'), history])
    document.prompt_order.unshift({ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] })
    expect((applyPreset(preset(document), { messages: [] }, { protocol: 'chat' }).messages as any[])[0].content).toBe('One')
    document.prompt_order[1]!.character_id = 100002
    expect(inspectPreset(document).supported).toBe(false)
    expect(inspectPreset(document).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ambiguous_order' })]))
  })

  it.each(['{{setvar::key::value}}', '{{getvar::key}}', '{{random::A,B}}', '{{date}}', '{{trim}}', '{{unknown}}'])('does not claim browser-only macro %s is implemented', text => {
    const document = source([prompt('main', text), history])
    expect(inspectPreset(document).supported).toBe(false)
    expect(() => applyPreset(preset(document), { messages: [] }, { protocol: 'chat' })).toThrow('预设存在不支持')
  })

  it('preserves complete raw unknown fields but blocks active request override scripts and missing history', () => {
    const document = { ...source([history]), unknown: { custom: ['retained'] }, custom_include_body: 'model: other' }
    expect(parsePresetJson(JSON.stringify(document))).toEqual(document)
    expect(inspectPreset(document).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unsupported_extension' })]))
    expect(inspectPreset(source([prompt('main', 'M')])).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing_history' })]))
  })

  it('maps protocol sampling defaults while preserving client choices', () => {
    const document = { ...source([prompt('main', 'Prefix'), history]), temperature: 0.6, top_p: 0.9, openai_max_tokens: 300, frequency_penalty: 1, stop: ['END'], top_k: 20 }
    expect(applyPreset(preset(document), { messages: [] }, { protocol: 'chat' })).toMatchObject({ temperature: 0.6, top_p: 0.9, max_tokens: 300, frequency_penalty: 1, stop: ['END'] })
    const messages = applyPreset(preset(document), { messages: [], system: [{ type: 'text', text: 'Client', cache_control: { type: 'ephemeral' } }] }, { protocol: 'messages' })
    expect(messages).toMatchObject({ top_k: 20, max_tokens: 300, stop_sequences: ['END'], system: [{ type: 'text', text: 'Client', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'Prefix' }] })
    expect(messages).not.toHaveProperty('frequency_penalty')
    const response = applyPreset(preset(document), { input: 'Hi', instructions: 'Client instructions', max_output_tokens: 200 }, { protocol: 'responses' })
    expect(response).toMatchObject({ max_output_tokens: 200, instructions: 'Client instructions', input: [{ role: 'system', content: 'Prefix' }, { role: 'user', content: 'Hi' }] })
    expect(response).not.toHaveProperty('frequency_penalty')
  })

  it('uses official ST Claude post-history conversion and refuses hidden Responses history', () => {
    const document = source([history, prompt('jailbreak', 'Tail')])
    expect(applyPreset(preset(document), { messages: [{ role: 'user', content: 'Hi' }] }, { protocol: 'messages' }).messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hi' }, { type: 'text', text: 'Tail' }] }])
    expect(() => applyPreset(preset(document), { input: 'Hi', previous_response_id: 'r1' }, { protocol: 'responses' })).toThrow('隐藏')
    expect(() => applyPreset(preset(document), { input: 'Hi', conversation: 'c1' }, { protocol: 'responses' })).toThrow('隐藏')
  })

  it('converts depth system prompts for Claude and retains multimodal tool blocks through role merges', () => {
    const document = source([prompt('main', 'Prefix'), history, prompt('jailbreak', 'Tail'), prompt('deep', 'In history', { injection_position: 1, injection_depth: 1 })])
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, toolUse = { type: 'tool_use', id: 't1', name: 'lookup', input: {} }, toolResult = { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Found' }], cache_control: { type: 'ephemeral' } }
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'Look' }, image] }, { role: 'assistant', content: [toolUse] }, { role: 'user', content: [toolResult] }]
    const result = applyPreset(preset(document), { messages, tools: [{ name: 'lookup' }] }, { protocol: 'messages' })
    expect(result.system).toEqual([{ type: 'text', text: 'Prefix' }])
    expect(result.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Look' }, image, { type: 'text', text: 'In history' }] }, messages[1], { role: 'user', content: [toolResult, { type: 'text', text: 'Tail' }] }])
    expect(messages[0]!.content).toHaveLength(2)
    expect((result.messages as any[])[2].content[0]).toBe(toolResult)
  })

  it('handles generation triggers without injecting prompts from other browser actions', () => {
    const document = source([history, prompt('normal', 'Regular', { injection_trigger: ['normal'] }), prompt('continue', 'Continue', { injection_trigger: ['continue'] })])
    expect(applyPreset(preset(document), { messages: [] }, { protocol: 'chat' }).messages).toEqual([{ role: 'system', content: 'Regular' }])
    expect(applyPreset(preset(document), { messages: [] }, { protocol: 'chat', generationType: 'continue' }).messages).toEqual([{ role: 'system', content: 'Continue' }])
  })

  it('accepts large and deeply nested JSON while validating structure and recognized variables', () => {
    expect(() => parsePresetJson('[')).toThrow('不是有效')
    expect(() => parsePresetJson([])).toThrow('JSON 对象')
    expect(() => parsePresetJson('{"__proto__":{"polluted":true}}')).toThrow('无效对象字段')
    expect(parsePresetJson({ text: 'x'.repeat(2 * 1024 * 1024) }).text).toHaveLength(2 * 1024 * 1024)
    let deep: any = {}; const root = deep
    for (let i = 0; i < 50; i++) { deep.child = {}; deep = deep.child }
    expect(parsePresetJson(root)).toEqual(root)
    expect(() => validatePresetVariables({ unknown: 'x' })).toThrow('无效')
    expect(() => validatePresetVariables({ char: 1 })).toThrow('无效')
  })

  it('reports duplicate prompt identifiers, invalid order, invalid trigger and sampler values before routing', () => {
    const document = { ...source([prompt('x', 'A'), prompt('x', 'B'), history]), temperature: -1 }
    expect(inspectPreset(document).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'duplicate_prompt' }), expect.objectContaining({ code: 'duplicate_order' }), expect.objectContaining({ code: 'invalid_parameter' })]))
    const invalid = source([history, prompt('x', 'A', { injection_position: 9, injection_trigger: ['extension-trigger'] })])
    expect(inspectPreset(invalid).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalid_position' }), expect.objectContaining({ code: 'invalid_trigger' })]))
  })

  it('preserves large repeated macros and marker templates without artificial expansion caps', () => {
    const repeated = source([prompt('main', '{{char}}'.repeat(100)), history])
    expect((applyPreset(preset(repeated, { char: 'x'.repeat(100_000) }), { messages: [] }, { protocol: 'chat' }).messages as any[])[0].content).toHaveLength(10_000_000)
    const wrapper = { ...source([{ identifier: 'scenario', marker: true }, history]), scenario_format: '{{scenario}}'.repeat(100) }
    expect((applyPreset(preset(wrapper, { scenario: 'x'.repeat(100_000) }), { messages: [] }, { protocol: 'chat' }).messages as any[])[0].content).toHaveLength(10_000_000)
    const collective = source([history, ...Array.from({ length: 80 }, (_, index) => prompt('p' + index, '{{char}}'))])
    expect((applyPreset(preset(collective, { char: 'x'.repeat(100_000) }), { messages: [] }, { protocol: 'chat' }).messages as any[])).toHaveLength(80)
  })
})

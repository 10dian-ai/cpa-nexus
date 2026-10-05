import { describe, expect, it } from 'vitest'
import { parsePluginField, pluginConfigFields, pluginExternalLink, pluginFieldText, pluginMenuHref, pluginMenuRoute } from '../app/utils/cpa-plugins'

const field = (type: string) => ({ name: 'custom', type, enumValues: ['first', 'second'], description: 'Plugin declared field' })
describe('native CPA plugin metadata configuration', () => {
  it('uses every plugin field without a fixed plugin ID or artificial string limit', () => {
    const fields = pluginConfigFields({ id: 'new-provider', metadata: { config_fields: [{ name: 'field.with.dots', type: 'string' }, { name: 'mode', type: 'enum', enum_values: ['new-model', 'custom'] }] } })
    expect(fields.map(item => item.name)).toEqual(['field.with.dots', 'mode'])
    const value = 'variable '.repeat(600_000)
    expect(parsePluginField(fields[0]!, value)).toBe(value)
    expect(parsePluginField(fields[1]!, 'custom')).toBe('custom')
  })
  it('validates types while preserving nested JSON and unknown field types', () => {
    expect(parsePluginField(field('boolean'), 'false')).toBe(false)
    expect(parsePluginField(field('integer'), '-200')).toBe(-200)
    expect(parsePluginField(field('number'), '3.5')).toBe(3.5)
    expect(parsePluginField(field('object'), '{"custom":{"values":[1,"x"]}}')).toEqual({ custom: { values: [1, 'x'] } })
    expect(parsePluginField(field('array'), '[{"a":1}]')).toEqual([{ a: 1 }])
    expect(parsePluginField(field('future-type'), '"new format"')).toBe('new format')
    expect(() => parsePluginField(field('integer'), '1.5')).toThrow()
    expect(() => parsePluginField(field('number'), '')).toThrow()
    expect(() => parsePluginField(field('number'), 'Infinity')).toThrow()
    expect(() => parsePluginField(field('object'), '[]')).toThrow()
    expect(() => parsePluginField(field('enum'), 'guessed-option')).toThrow()
  })
  it('retains false and empty string as deliberate values, and rejects executable external links', () => {
    expect(pluginFieldText(false, field('boolean'))).toBe('false')
    expect(pluginFieldText('', field('string'))).toBe('')
    expect(pluginFieldText(undefined, field('string'))).toBe('')
    expect(pluginExternalLink('https://github.com/example/provider')).toBe('https://github.com/example/provider')
    expect(pluginExternalLink('javascript:alert(1)')).toBe('')
    expect(pluginExternalLink('https://secret@example.com')).toBe('')
  })
  it('opens arbitrary installed plugin resources within their actual namespace', () => {
    expect(pluginMenuHref('new-provider', { path: '/v0/resource/plugins/new-provider/pages/editor.html?mode=custom#details' })).toBe('/api/cpa/console/v0/resource/plugins/new-provider/pages/editor.html?mode=custom#details')
    expect(pluginMenuHref('new-provider', { path: '/v0/resource/plugins/other-plugin/page' })).toBe('')
    expect(pluginMenuHref('new-provider', { path: '/v0/resource/plugins/new-provider/../../management/api-call' })).toBe('')
    expect(pluginMenuRoute('new-provider', 2)).toBe('/cpa/plugin-pages/new-provider/2')
    expect(pluginMenuRoute('new-provider', -1)).toBe('')
  })
})

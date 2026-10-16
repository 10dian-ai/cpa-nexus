import { describe, expect, it } from 'vitest'
import { ResponseCapture } from '../server/lib/http/response-capture'
const encoder = new TextEncoder()
const sse = (data: unknown) => encoder.encode('data: ' + JSON.stringify(data) + '\n\n')

describe('response log byte limit', () => {
  it('keeps the full business payload within the cap and marks truncation beyond it', () => {
    const capture = new ResponseCapture(10)
    capture.push(encoder.encode('12345'))
    capture.push(encoder.encode('6789012345'))
    expect(capture.text()).toBe('1234567890')
    expect(capture.value(true)).toEqual({ format: 'sse', raw: '1234567890', truncated: true })
  })
  it('stores JSON as an object without changing response content', () => {
    const capture = new ResponseCapture()
    capture.push(encoder.encode('{"answer":"你好","usage":{"input_tokens":3}}'))
    expect(capture.value(false)).toEqual({ answer: '你好', usage: { input_tokens: 3 } })
    expect(capture.truncated).toBe(false)
  })
})
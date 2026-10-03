import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CORE_SOURCE_SHA256 = 'd395956d2fdec6dc0fac5051fccb388e40c8c25b5fdb2211204b5b4a0c6dfaa0'
export const CORE_COMMIT = '6217305'
export const CORE_CLI_VERSION = '1.53.0'
export const CORE_PATCHES = [
  'preserve-responses-prompt-cache-key',
  'accept-responses-message-without-type',
  'require-upstream-finish-before-responses-completion',
  'reject-responses-store-true',
  'pin-cli-version-without-network-refresh',
  'cancel-chat-and-messages-before-upstream-headers',
  'require-upstream-finish-for-all-protocols',
  'preserve-unterminated-chat-and-messages-events',
  'accept-chat-output-without-usage',
  'preserve-observed-usage-without-estimation',
]
function replaceOnce(source, before, after, label) {
  const at = source.indexOf(before)
  if (at < 0 || source.indexOf(before, at + before.length) !== -1)
    throw new Error('Core patch anchor is missing or ambiguous: ' + label)
  return source.slice(0, at) + after + source.slice(at + before.length)
}
function patchChatAndMessages(source) {
  const start = source.indexOf('function createSseTranslator(')
  const end = source.indexOf('async function fetchModels(', start)
  if (start < 0 || end < start) throw new Error('Chat/Messages sections not found')
  let section = source.slice(start, end)
  section = replaceOnce(section, "    lastCcEvent: '',", "    lastCcEvent: '',\n    finishReceived: false,\n    get hasOutput() { return chunkIndex > 0; },", 'chat completion evidence')
  section = replaceOnce(section, "        case 'finish': {\n          const fr", "        case 'finish': {\n          this.finishReceived = true;\n          const fr", 'chat stream finish')
  section = replaceOnce(section, '          if (translator.upstreamError) {',
    "          if (!translator.finishReceived && !translator.upstreamError) {\n            translator.upstreamError = { status: 502, body: { error: { type: 'upstream_error', message: 'Upstream stream ended without finish event' } } };\n          }\n          if (translator.upstreamError) {", 'chat stream EOF')
  section = replaceOnce(section, '          } else if (translator.outputTokens === 0) {',
    '          } else if (!translator.hasOutput) {', 'chat output without usage')
  section = replaceOnce(section, '              if (!started) started = true;',
    "              if (!started) {\n                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });\n                started = true;\n              }", 'chat final line SSE headers')
  section = replaceOnce(section, '      if ((usage?.outputTokens ?? 0) === 0) {',
    '      if (!fullText && !reasoningContent && !toolCalls?.length) {', 'chat nonstream output without usage')
  section = replaceOnce(section, "          const fr = finishReason || mapFinishReason(event.finishReason || 'stop');",
    "          if (this.upstreamError) break;\n          const fr = mapFinishReason(event.finishReason || finishReason || 'stop');", 'chat authoritative final finish')
  section = replaceOnce(section, '          const u = event.totalUsage || usage || {};',
    '          const u = event.totalUsage || event.usage || usage || {};', 'chat stream finish usage')
  section = replaceOnce(section, '                if (event.totalUsage) usage = event.totalUsage;',
    '                if (event.totalUsage || event.usage) usage = event.totalUsage || event.usage;', 'chat nonstream finish usage')

  // A close event is not replayed if the listener is installed after fetch.
  for (const [name, next] of [['handleChatCompletions', 'function mapAnthropicStopReason('], ['handleMessages', null]]) {
    const handlerStart = section.indexOf('async function ' + name + '(')
    const handlerEnd = next ? section.indexOf(next, handlerStart) : section.length
    let handler = section.slice(handlerStart, handlerEnd)
    const closeStart = handler.indexOf("    res.on('close', () => {")
    const closeEnd = handler.indexOf('\n    });', closeStart) + '\n    });'.length
    if (handlerStart < 0 || handlerEnd < handlerStart || closeStart < 0 || closeEnd < closeStart)
      throw new Error('Core cancellation anchors are missing: ' + name)
    const listener = handler.slice(closeStart, closeEnd)
    handler = handler.slice(0, closeStart) + handler.slice(closeEnd)
    handler = replaceOnce(handler, '\n  try {\n    // 首次初始化',
      '\n' + listener + '\n\n  if (res.destroyed) { abortController.abort(); return; }\n\n  try {\n    // 首次初始化', name + ' early cancellation')
    handler = replaceOnce(handler, "      let finishReason = 'stop';", "      let finishReason = 'stop';\n      let finishReceived = false;", name + ' nonstream finish tracking')
    handler = replaceOnce(handler, "              case 'finish':\n                lastCcEvent", "              case 'finish':\n                finishReceived = true;\n                lastCcEvent", name + ' nonstream finish')
    handler = replaceOnce(handler, '      idle.dispose();\n      processLines();',
      "      idle.dispose();\n      buf += decoder.decode();\n      if (buf.trim()) buf += '\\n';\n      processLines();", name + ' final NDJSON line')
    const finishError = name === 'handleMessages'
      ? "        sendAnthropicError(res, 502, 'upstream_error', 'Upstream stream ended without finish event');"
      : "        sendJSON(res, 502, { error: { type: 'upstream_error', message: 'Upstream stream ended without finish event' } });"
    handler = replaceOnce(handler, '      consecutiveTimeouts = 0;\n      sendJSON(res, 200,',
      '      if (!finishReceived) {\n' + finishError + '\n        return;\n      }\n\n      consecutiveTimeouts = 0;\n      sendJSON(res, 200,', name + ' nonstream EOF')
    section = section.slice(0, handlerStart) + handler + section.slice(handlerEnd)
  }
  const anthropicStart = section.indexOf('async function* createAnthropicSseTranslator(')
  const anthropicEnd = section.indexOf('function sendAnthropicError(', anthropicStart)
  let anthropic = section.slice(anthropicStart, anthropicEnd)
  anthropic = replaceOnce(anthropic, '  let hasError = false;', '  let hasError = false;\n  let finishReceived = false;', 'messages stream finish tracking')
  anthropic = replaceOnce(anthropic, "          case 'finish': {\n            if (event.finishReason)",
    "          case 'finish': {\n            if (event.type === 'finish') finishReceived = true;\n            if (event.finishReason)", 'messages stream finish')
  anthropic = replaceOnce(anthropic,
    "      if (done) break;\n      ctx.bytesReceived += value.length;\n      const chunkText = decoder.decode(value, { stream: true });",
    "      if (done && !buffer.trim()) break;\n      if (!done) ctx.bytesReceived += value.length;\n      const chunkText = done ? decoder.decode() + '\\n' : decoder.decode(value, { stream: true });", 'messages final NDJSON line')
  anthropic = replaceOnce(anthropic, '      }\n    }\n\n    // 无论上游', '      }\n      if (done) break;\n    }\n\n    // 无论上游', 'messages final read completion')
  anthropic = replaceOnce(anthropic, '    if (!hasError) {',
    "    if (!finishReceived && !hasError) {\n      ctx.upstreamError = { status: 502, body: { error: { type: 'upstream_error', message: 'Upstream stream ended without finish event' } } };\n      yield `event: error\\ndata: ${JSON.stringify({ type: 'error', error: ctx.upstreamError.body.error })}\\n\\n`;\n      return;\n    }\n    if (!hasError) {", 'messages stream EOF')
  section = section.slice(0, anthropicStart) + anthropic + section.slice(anthropicEnd)
  return source.slice(0, start) + section + source.slice(end)
}
function patchObservedUsage(source) {
  const helpers = `function managerToken(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function managerUsage(fields) {
  const known = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  return Object.keys(known).length ? known : undefined;
}
function managerChatUsage(usage) {
  if (!usage) return undefined;
  const input = managerToken(usage.inputTokens), output = managerToken(usage.outputTokens);
  const cached = managerToken(usage.cachedInputTokens);
  return managerUsage({ prompt_tokens: input, completion_tokens: output,
    total_tokens: input !== undefined && output !== undefined ? input + output : undefined,
    prompt_tokens_details: cached !== undefined ? { cached_tokens: cached } : undefined });
}
function managerAnthropicUsage(usage) {
  if (!usage) return {};
  return managerUsage({ input_tokens: managerToken(usage.inputTokenDetails?.noCacheTokens),
    output_tokens: managerToken(usage.outputTokens),
    cache_read_input_tokens: managerToken(usage.cachedInputTokens),
    cache_creation_input_tokens: managerToken(usage.inputTokenDetails?.cacheWriteTokens) }) || {};
}
function managerResponsesUsage(usage) {
  if (!usage) return null;
  const input = managerToken(usage.inputTokens), output = managerToken(usage.outputTokens);
  return managerUsage({ input_tokens: input, output_tokens: output,
    total_tokens: input !== undefined && output !== undefined ? input + output : undefined,
    input_tokens_details: managerUsage({ cached_tokens: managerToken(usage.cachedInputTokens),
      cache_write_tokens: managerToken(usage.inputTokenDetails?.cacheWriteTokens) }),
    output_tokens_details: managerUsage({ reasoning_tokens: managerToken(usage.outputTokenDetails?.reasoningTokens) }) }) || null;
}
`
  // Upstream zero output does not erase observed input/cache usage.
  const normalizeStart = source.indexOf('function normalizeUsage(')
  const normalizeEnd = source.indexOf('\n}', normalizeStart) + 2
  if (normalizeStart < 0 || normalizeEnd < normalizeStart) throw new Error('Usage normalization anchors missing')
  source = source.slice(0, normalizeStart) + helpers + 'function normalizeUsage(u) { return u; }' + source.slice(normalizeEnd)
  function replaceBlock(before, after, replacement, label) {
    const start = source.indexOf(before)
    const end = source.indexOf(after, start) + after.length
    if (start < 0 || end < start || source.indexOf(before, start + before.length) !== -1)
      throw new Error('Usage patch anchors missing or ambiguous: ' + label)
    source = source.slice(0, start) + replacement + source.slice(end)
  }
  replaceBlock('          const openaiUsage = u ? {', '          } : undefined;',
    '          const openaiUsage = managerChatUsage(u);', 'chat streaming usage')
  replaceBlock('    usage: (() => {\n      if (!usage) usage = {};', '    })(),',
    '    usage: managerChatUsage(usage),', 'chat JSON usage')
  replaceBlock('    usage: (() => {\n      normalizeUsage(usage || {});', '    })(),',
    '    usage: managerAnthropicUsage(usage),', 'messages JSON usage')
  replaceBlock('function buildResponsesUsage(usage, fallbackOutputTokens) {', '\n}',
    'function buildResponsesUsage(usage) { return managerResponsesUsage(usage); }', 'responses usage')
  const start = source.indexOf('async function* createAnthropicSseTranslator(')
  const end = source.indexOf('function sendAnthropicError(', start)
  let section = source.slice(start, end)
  section = replaceOnce(section, '  let hasError = false;', '  let hasError = false;\n  let hasOutput = false;\n  let observedUsage = null;', 'messages real usage tracking')
  section = replaceOnce(section, '      usage: { input_tokens: 0, output_tokens: 0 },', '      usage: {},', 'messages no invented initial usage')
  section = replaceOnce(section, '            outputTokens += 1;', '            hasOutput = hasOutput || !!text;', 'messages text evidence')
  section = replaceOnce(section, '            outputTokens += 20;', '            hasOutput = true;', 'messages tool evidence')
  section = replaceOnce(section, '            currentThinkingText += text;', '            hasOutput = true;\n            currentThinkingText += text;', 'messages thinking evidence')
  section = replaceOnce(section, '            if (u) {\n              normalizeUsage(u);',
    '            if (u) {\n              observedUsage = { ...(observedUsage || {}), ...u, inputTokenDetails: { ...(observedUsage?.inputTokenDetails || {}), ...(u.inputTokenDetails || {}) } };\n              normalizeUsage(u);', 'messages observed usage')
  section = replaceOnce(section, '    ctx.cacheWriteTokens = cacheWriteTokens;', '    ctx.cacheWriteTokens = cacheWriteTokens;\n    ctx.hasOutput = hasOutput;', 'messages output evidence')
  section = replaceOnce(section, '      if (outputTokens === 0) {', '      if (!hasOutput) {', 'messages content-based empty detection')
  const usageStart = section.indexOf('          usage: {\n            output_tokens: outputTokens,')
  const usageEnd = section.indexOf('\n          },', usageStart) + '\n          },'.length
  if (usageStart < 0 || usageEnd < usageStart) throw new Error('Messages streaming usage anchors missing')
  section = section.slice(0, usageStart) + '          usage: managerAnthropicUsage(observedUsage),' + section.slice(usageEnd)
  source = source.slice(0, start) + section + source.slice(end)
  source = replaceOnce(source, '          } else if (ctx.outputTokens === 0) {', '          } else if (!ctx.hasOutput) {', 'messages handler output evidence')
  // Nonstream reader rejection must also dispose its watchdog.
  const idleStart = '      const idle = createIdleWatchdog(NONSTREAM_IDLE_TIMEOUT_MS);\n      while (true) {'
  const idleEnd = '      }\n      idle.dispose();\n'
  if (source.split(idleStart).length !== 4 || source.split(idleEnd).length !== 4)
    throw new Error('Nonstream watchdog anchors missing or ambiguous')
  source = source.replaceAll(idleStart, '      const idle = createIdleWatchdog(NONSTREAM_IDLE_TIMEOUT_MS);\n      try {\n      while (true) {')
    .replaceAll(idleEnd, '      }\n      } finally { idle.dispose(); }\n')
  return source
}
export function applyCorePatches(original) {
  const hash = createHash('sha256').update(original).digest('hex')
  if (hash !== CORE_SOURCE_SHA256)
    throw new Error('Core source checksum mismatch; review the source before changing the lock')
  let source = original.toString('utf8').replace(/\r\n/g, '\n')
  const versionStart = source.indexOf("let CC_VERSION = '0.32.3';")
  const versionEndMarker = 'setInterval(refreshCCVersion, CC_VERSION_REFRESH_MS);'
  const versionEnd = source.indexOf(versionEndMarker, versionStart)
  if (versionStart < 0 || versionEnd < versionStart) throw new Error('Core version pin anchors are missing')
  source = source.slice(0, versionStart) +
    "// CommandCode Manager build: version is pinned; upgrades require a reviewed build.\n" +
    "const CC_VERSION = '" + CORE_CLI_VERSION + "';\n" +
    source.slice(versionEnd + versionEndMarker.length)

  const start = source.indexOf('function responsesTextOf(')
  const end = source.indexOf('async function handleModels(', start)
  if (start < 0 || end < start) throw new Error('Responses section not found')
  let section = source.slice(start, end)
  section = replaceOnce(section,
    "      switch (item.type) {",
    "      const itemType = item.type === undefined && ['user', 'assistant', 'system', 'developer'].includes(item.role) ? 'message' : item.type;\n      switch (itemType) {",
    'implicit message')
  section = replaceOnce(section,
    '  if (eff) out.reasoning_effort = eff;\n  return out;',
    "  if (eff) out.reasoning_effort = eff;\n  if (typeof respReq.prompt_cache_key === 'string') out.prompt_cache_key = respReq.prompt_cache_key;\n  return out;",
    'prompt cache key')
  section = replaceOnce(section,
    '  if (respReq.previous_response_id) {',
    "  if (respReq.store === true) {\n    sendResponsesError(res, 400, 'invalid_request_error', 'store:true is not supported (this proxy is stateless)');\n    return;\n  }\n\n  if (respReq.previous_response_id) {",
    'store rejection')
  section = replaceOnce(section,
    '  let finishReason = null;',
    '  let finishReason = null;\n  let finishReceived = false;',
    'stream finish tracking')
  section = replaceOnce(section,
    "        case 'finish': {\n          finishReason = event.finishReason || null;",
    "        case 'finish': {\n          finishReceived = true;\n          finishReason = event.finishReason || null;",
    'stream finish observation')
  section = replaceOnce(section,
    '    finish() {\n      if (!createdSent) return [];',
    "    finish() {\n      if (!createdSent) return [];\n      if (!finishReceived) return this.fail('Upstream stream ended without finish event');",
    'stream EOF validation')
  section = replaceOnce(section,
    "      let finishReason = 'stop';",
    "      let finishReason = 'stop';\n      let finishReceived = false;",
    'nonstream finish tracking')
  section = replaceOnce(section,
    "            case 'finish':\n              lastCcEvent = event.type;",
    "            case 'finish':\n              finishReceived = true;\n              lastCcEvent = event.type;",
    'nonstream finish observation')
  section = replaceOnce(section,
    '      idle.dispose();\n      processLines();',
    "      idle.dispose();\n      if (buf.trim()) buf += '\\n';\n      processLines();",
    'unterminated final NDJSON line')
  section = replaceOnce(section,
    '      if (!fullText && !thinkingText && !toolCalls.length) {',
    "      if (!finishReceived) {\n        sendResponsesError(res, 502, 'upstream_error', 'Upstream stream ended without finish event');\n        return;\n      }\n\n      if (!fullText && !thinkingText && !toolCalls.length) {",
    'nonstream EOF validation')
  return patchObservedUsage(patchChatAndMessages(source.slice(0, start) + section + source.slice(end)))
}
export async function buildCore(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const input = resolve(root, 'reference/commandcode-proxy-' + CORE_COMMIT)
  const output = resolve(root, 'core/dist')
  const source = applyCorePatches(await readFile(resolve(input, 'proxy.mjs')))
  await mkdir(output, { recursive: true })
  await writeFile(resolve(output, 'proxy.mjs'), source, 'utf8')
  await copyFile(resolve(input, 'LICENSE'), resolve(output, 'LICENSE'))
  const config = JSON.parse(await readFile(resolve(input, 'config.json'), 'utf8'))
  await writeFile(resolve(output, 'config.json'), JSON.stringify({ ...config, port: 3050, host: '0.0.0.0', logFile: '' }, null, 2) + '\n', 'utf8')
  await writeFile(resolve(output, 'build-manifest.json'), JSON.stringify({
    repository: 'MAXeaglet/commandcode-proxy', commit: CORE_COMMIT,
    sourceSha256: CORE_SOURCE_SHA256, builtSha256: createHash('sha256').update(source).digest('hex'),
    cliVersion: CORE_CLI_VERSION, patches: CORE_PATCHES,
  }, null, 2) + '\n', 'utf8')
  return output
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await buildCore()
  console.log('Core built at ' + output)
}
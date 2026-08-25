import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const auditDir = path.resolve(process.env.STORAGE_DIR || path.resolve(__dirname, '..', 'storage'), 'logs')
const auditPath = path.join(auditDir, 'model-audit.log')

export async function callSharedModel({ messages, purpose, mockContent = '' }) {
  const startedAt = Date.now()
  const endpoint = String(
    process.env.AI_MODEL_API_URL ||
      process.env.TRANSLATION_API_URL ||
      'http://172.28.200.7:7888/qwen3long/v1/chat/completions',
  ).trim()
  const model = String(process.env.AI_MODEL_NAME || process.env.TRANSLATION_MODEL || 'Qwen-Lite').trim()
  const requestBody = {
    model,
    messages,
    chat_template_kwargs: { enable_thinking: false },
  }

  if (isMockMode()) {
    const content = mockContent || '[模拟模型结果]'
    const diagnostics = buildDiagnostics({ content })
    await writeAudit({
      purpose,
      endpoint,
      model,
      status: 'mock',
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      ...diagnostics,
    })
    return { content, diagnostics }
  }

  const headers = { 'Content-Type': 'application/json' }
  const apiKey = String(process.env.AI_MODEL_API_KEY || '').trim()
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  let response
  let data
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    })
    data = await readJsonResponse(response)
    const content = extractModelContent(data)
    const diagnostics = buildDiagnostics({ content, data })
    await writeAudit({
      purpose,
      endpoint,
      model,
      status: response.ok ? 'success' : 'failed',
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
      ...diagnostics,
    })
    if (!response.ok) {
      throw new Error(extractModelError(data) || `模型调用失败，状态码 ${response.status}`)
    }
    if (!content) throw new Error('模型未返回可用内容')
    return { content, diagnostics }
  } catch (error) {
    if (!response) {
      await writeAudit({
        purpose,
        endpoint,
        model,
        status: 'failed',
        statusCode: null,
        durationMs: Date.now() - startedAt,
        responseHasReasoning: false,
        reasoningLength: 0,
        contentContainsThinkTag: false,
        error: error.message,
      })
    }
    throw error
  }
}

export async function callSharedModelStream({ messages, purpose, mockContent = '', onDelta }) {
  const startedAt = Date.now()
  const endpoint = String(
    process.env.AI_MODEL_API_URL ||
      process.env.TRANSLATION_API_URL ||
      'http://172.28.200.7:7888/qwen3long/v1/chat/completions',
  ).trim()
  const model = String(process.env.AI_MODEL_NAME || process.env.TRANSLATION_MODEL || 'Qwen-Lite').trim()

  if (isMockMode()) {
    const content = mockContent || '[模拟模型结果]'
    let streamed = ''
    for (const chunk of content.match(/.{1,24}/gs) || [content]) {
      streamed += chunk
      onDelta?.(streamed)
      await new Promise((resolve) => setTimeout(resolve, 8))
    }
    const diagnostics = buildDiagnostics({ content })
    await writeAudit({
      purpose,
      endpoint,
      model,
      status: 'mock',
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      ...diagnostics,
    })
    return { content, diagnostics }
  }

  const headers = { 'Content-Type': 'application/json' }
  const apiKey = String(process.env.AI_MODEL_API_KEY || '').trim()
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  let response
  let rawContent = ''
  let reasoningContent = ''
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    })

    const contentType = response.headers.get('content-type') || ''
    if (!response.ok || contentType.includes('application/json')) {
      const data = await readJsonResponse(response)
      if (!response.ok) throw new Error(extractModelError(data) || `模型调用失败，状态码 ${response.status}`)
      rawContent = extractModelContent(data)
      onDelta?.(stripStreamingThinking(rawContent))
      reasoningContent = String(
        data?.choices?.[0]?.message?.reasoning_content || data?.choices?.[0]?.message?.reasoning || '',
      )
    } else {
      const reader = response.body?.getReader()
      if (!reader) throw new Error('模型流式响应不可读取')
      const decoder = new TextDecoder()
      let buffer = ''
      let finished = false
      while (!finished) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) {
          const parsed = parseStreamLine(line)
          if (parsed === 'done') {
            finished = true
            break
          }
          if (!parsed) continue
          rawContent += parsed.content
          reasoningContent += parsed.reasoning
          onDelta?.(stripStreamingThinking(rawContent))
        }
      }
      buffer += decoder.decode()
      const parsed = parseStreamLine(buffer)
      if (parsed && parsed !== 'done') {
        rawContent += parsed.content
        reasoningContent += parsed.reasoning
        onDelta?.(stripStreamingThinking(rawContent))
      }
    }

    const content = stripStreamingThinking(rawContent).trim()
    if (!content) throw new Error('模型未返回可用内容')
    const diagnostics = {
      ...buildDiagnostics({ content }),
      responseHasReasoning: Boolean(reasoningContent.trim()),
      reasoningLength: reasoningContent.trim().length,
    }
    await writeAudit({
      purpose,
      endpoint,
      model,
      status: 'success',
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
      ...diagnostics,
    })
    return { content, diagnostics }
  } catch (error) {
    await writeAudit({
      purpose,
      endpoint,
      model,
      status: 'failed',
      statusCode: response?.status || null,
      durationMs: Date.now() - startedAt,
      responseHasReasoning: Boolean(reasoningContent.trim()),
      reasoningLength: reasoningContent.trim().length,
      contentContainsThinkTag: /<\/?think\b/i.test(rawContent),
      error: error.message,
    })
    throw error
  }
}

export async function readModelAudit(limit = 30) {
  try {
    const content = await fsp.readFile(auditPath, 'utf8')
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(Number(limit) || 30, 100)))
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function isMockMode() {
  return String(process.env.MOCK_AI || '').toLowerCase() === 'true'
}

async function readJsonResponse(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

function extractModelContent(data) {
  const value =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    data?.answer ??
    data?.response ??
    data?.content ??
    data?.data?.content ??
    ''
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item : item?.text || '')).join('')
  }
  return String(value || '').trim()
}

function extractModelError(data) {
  const value = data?.error?.message || data?.error || data?.message
  return typeof value === 'string' ? value : ''
}

function parseStreamLine(line) {
  const trimmed = String(line || '').trim()
  if (!trimmed || !trimmed.startsWith('data:')) return null
  const payload = trimmed.slice(5).trim()
  if (payload === '[DONE]') return 'done'
  try {
    const data = JSON.parse(payload)
    const delta = data?.choices?.[0]?.delta || data?.choices?.[0]?.message || {}
    const contentValue = delta.content ?? delta.text ?? ''
    const content = Array.isArray(contentValue)
      ? contentValue.map((item) => (typeof item === 'string' ? item : item?.text || '')).join('')
      : String(contentValue || '')
    const reasoning = String(delta.reasoning_content || delta.reasoning || '')
    return { content, reasoning }
  } catch {
    return null
  }
}

function stripStreamingThinking(value) {
  return String(value || '')
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/<think[\s\S]*$/gi, '')
    .replace(/<\/?think>/gi, '')
}

function buildDiagnostics({ content, data = null }) {
  const reasoning =
    data?.choices?.[0]?.message?.reasoning_content ??
    data?.choices?.[0]?.message?.reasoning ??
    data?.reasoning_content ??
    data?.thinking ??
    ''
  const reasoningText = typeof reasoning === 'string' ? reasoning : JSON.stringify(reasoning || '')
  return {
    enableThinking: false,
    thinkingDisabledRequested: true,
    thinkingRequested: false,
    responseHasReasoning: Boolean(reasoningText.trim()),
    reasoningLength: reasoningText.trim().length,
    contentContainsThinkTag: /<\/?think\b/i.test(String(content || '')),
  }
}

async function writeAudit(entry) {
  await fsp.mkdir(auditDir, { recursive: true })
  let endpointPath = entry.endpoint
  try {
    const url = new URL(entry.endpoint)
    endpointPath = `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    // Keep the configured value when it is not a valid absolute URL.
  }
  const safeEntry = {
    timestamp: new Date().toISOString(),
    purpose: entry.purpose,
    endpoint: endpointPath,
    model: entry.model,
    enableThinking: false,
    thinkingDisabledRequested: true,
    thinkingRequested: false,
    status: entry.status,
    statusCode: entry.statusCode,
    durationMs: entry.durationMs,
    responseHasReasoning: Boolean(entry.responseHasReasoning),
    reasoningLength: Number(entry.reasoningLength || 0),
    contentContainsThinkTag: Boolean(entry.contentContainsThinkTag),
    ...(entry.error ? { error: String(entry.error).slice(0, 500) } : {}),
  }
  await fsp.appendFile(auditPath, `${JSON.stringify(safeEntry)}\n`, 'utf8')
}

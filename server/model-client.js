import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const auditDir = path.resolve(__dirname, '..', 'storage', 'logs')
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

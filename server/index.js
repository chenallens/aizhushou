import 'dotenv/config'
import express from 'express'
import session from 'express-session'
import cookieParser from 'cookie-parser'
import multer from 'multer'
import initSqlJs from 'sql.js'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { Agent } from 'undici'
import { callSharedModel, readModelAudit } from './model-client.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const storageDir = path.join(rootDir, 'storage')
const uploadDir = path.join(storageDir, 'uploads')
const glossaryDir = path.join(storageDir, 'glossaries')
const convertedDir = path.join(storageDir, 'converted')
const resultsDir = path.join(storageDir, 'results')
const dbPath = path.join(storageDir, 'aizhushou.sqlite')
const port = Number(process.env.SERVER_PORT || 4178)

const defaultQaBotId = '7172f29d-69c1-4f71-9646-03ab127e8f53'
const defaultStandardPrompt = `你是制造企业标准解读专家。请准确理解上传标准，不改变原文事实、数值、单位和约束条件。
请从长文档中提取适用范围、核心要求、关键指标、职责分工、操作步骤、风险与禁止事项、检查验收要点。
输出清晰的 Markdown，使用层级标题、编号列表和表格组织内容。公式保留原有 LaTeX 或文本表达，不编造缺失信息。
不要描述你的处理过程，不要输出思考过程，只输出可直接交付的标准解读正文。`
const uploadLimits = { fileSize: 200 * 1024 * 1024 }
const qaTokenCache = new Map()
const insecureQaDispatcher =
  String(process.env.QA_TLS_REJECT_UNAUTHORIZED || '').toLowerCase() === 'false'
    ? new Agent({ connect: { rejectUnauthorized: false } })
    : null

await ensureDirectories()
const db = await openDatabase()
ensureSchema()

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase()
      cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`)
    },
  }),
  limits: uploadLimits,
})

const app = express()
app.set('trust proxy', 1)
app.use(cookieParser())
app.use(express.json({ limit: '2mb' }))
app.use(
  session({
    name: 'aizhushou.sid',
    secret: process.env.SESSION_SECRET || 'aizhushou-local-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 8,
    },
  }),
)

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'aizhushou', time: new Date().toISOString() })
})

app.get('/api/me', (req, res) => {
  res.json({ isAdmin: Boolean(req.session?.isAdmin), username: req.session?.username || null })
})

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {}
  const expectedUser = process.env.ADMIN_USERNAME || 'admin'
  const expectedPass = process.env.ADMIN_PASSWORD || 'change-me'
  if (username === expectedUser && password === expectedPass) {
    req.session.isAdmin = true
    req.session.username = expectedUser
    res.json({ ok: true, isAdmin: true, username: expectedUser })
    return
  }
  res.status(401).json({ error: '管理员账号或密码不正确' })
})

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }))
})

app.post('/api/visit', (_req, res) => {
  recordEvent('visit')
  res.json({ ok: true })
})

app.post('/api/usage/:assistant', (req, res) => {
  const map = {
    qa: 'qa_click',
    translation: 'translation_click',
    pdf: 'pdf_click',
    standard: 'standard_click',
  }
  const eventType = map[req.params.assistant]
  if (!eventType) {
    res.status(400).json({ error: '未知助手类型' })
    return
  }
  recordEvent(eventType)
  res.json({ ok: true })
})

app.get('/api/stats', (_req, res) => {
  res.json(getStats())
})

app.get('/api/feedback', (_req, res) => {
  const rows = all(
    `SELECT id, content, reply, created_at AS createdAt, replied_at AS repliedAt
     FROM feedback
     ORDER BY datetime(created_at) DESC`,
  )
  res.json({ items: rows })
})

app.post('/api/feedback', (req, res) => {
  const content = String(req.body?.content || '').trim()
  if (!content) {
    res.status(400).json({ error: '反馈内容不能为空' })
    return
  }
  if (content.length > 2000) {
    res.status(400).json({ error: '反馈内容不能超过 2000 字' })
    return
  }
  run('INSERT INTO feedback (content, created_at) VALUES (?, ?)', [content, now()])
  res.json({ ok: true, item: get('SELECT * FROM feedback ORDER BY id DESC LIMIT 1') })
})

app.patch('/api/feedback/:id/reply', requireAdmin, (req, res) => {
  const reply = String(req.body?.reply || '').trim()
  if (!reply) {
    res.status(400).json({ error: '回复内容不能为空' })
    return
  }
  run('UPDATE feedback SET reply = ?, replied_at = ? WHERE id = ?', [reply, now(), req.params.id])
  res.json({ ok: true })
})

app.get('/api/glossaries', (_req, res) => {
  const rows = all(
    `SELECT id, original_name AS originalName, stored_name AS storedName,
      converted_name AS convertedName, created_at AS createdAt
     FROM glossaries
     ORDER BY datetime(created_at) DESC`,
  )
  res.json({ items: rows })
})

app.get('/api/admin/prompts', requireAdmin, (_req, res) => {
  res.json({
    items: all(
      `SELECT assistant_id AS assistantId, prompt, updated_at AS updatedAt
       FROM assistant_prompts ORDER BY assistant_id`,
    ),
  })
})

app.put('/api/admin/prompts/:assistantId', requireAdmin, (req, res) => {
  const assistantId = String(req.params.assistantId || '')
  if (!['standard-plant-1', 'standard-plant-2', 'standard-plant-3'].includes(assistantId)) {
    res.status(404).json({ error: '未找到该标准解读助手' })
    return
  }
  const prompt = String(req.body?.prompt || '').trim()
  if (!prompt) {
    res.status(400).json({ error: '提示词不能为空' })
    return
  }
  if (prompt.length > 12000) {
    res.status(400).json({ error: '提示词不能超过 12000 字' })
    return
  }
  run(
    `INSERT INTO assistant_prompts (assistant_id, prompt, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(assistant_id) DO UPDATE SET prompt = excluded.prompt, updated_at = excluded.updated_at`,
    [assistantId, prompt, now()],
  )
  res.json({ ok: true })
})

app.get('/api/admin/model-audit', requireAdmin, async (req, res, next) => {
  try {
    res.json({ items: await readModelAudit(req.query.limit) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/glossaries', requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: '请选择要上传的词库文件' })
      return
    }
    const extracted = await extractDocument(req.file.path, req.file.originalname, glossaryDir)
    const storedPath = path.join(glossaryDir, req.file.filename)
    await fsp.rename(req.file.path, storedPath)
    run(
      `INSERT INTO glossaries
        (original_name, stored_name, converted_name, text_content, html_content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.file.originalname,
        req.file.filename,
        path.basename(extracted.convertedPath),
        extracted.text,
        extracted.html,
        now(),
      ],
    )
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/qa/chat', async (req, res, next) => {
  try {
    const messages = normalizeMessages(req.body)
    if (!messages.length) {
      res.status(400).json({ error: '请输入问题' })
      return
    }

    if (isMockMode()) {
      const last = messages.at(-1)?.content || ''
      res.json({
        answer: `模拟回答：已收到“${last}”。切换到内网并配置 QA_API_BASE_URL 后将调用制造一厂知识问答助手。`,
      })
      return
    }

    const baseUrl = normalizeBaseUrl(process.env.QA_API_BASE_URL)
    if (!baseUrl) {
      res.status(400).json({ error: '请先在 .env 中配置 QA_API_BASE_URL' })
      return
    }

    const account = resolveQaAccount(req.body)
    if (!account) {
      res.status(400).json({ error: '未获取到 OA 账号，请从 OA 入口访问本系统，或在 .env 中配置 QA_DEFAULT_ACCOUNT 用于测试' })
      return
    }

    const token = await getQaAccessToken(baseUrl, account)
    const query = messages.at(-1)?.content || ''
    const response = await fetch(`${baseUrl}/api/intelli-search/v2/bots/${process.env.QA_BOT_ID || defaultQaBotId}/chat`, {
      method: 'POST',
      headers: buildJsonHeaders(token),
      body: JSON.stringify({
        conversation_id: crypto.randomUUID(),
        query,
        times: 0,
        parent_qa_id: '1',
      }),
      ...qaFetchOptions(),
    })
    const data = await parseQaResponse(response)
    if (!response.ok) {
      res.status(response.status).json({ error: data?.error || data?.message || '问答助手接口调用失败' })
      return
    }
    const cites = normalizeQaCites(extractQaCites(data), baseUrl, token)
    res.json({ answer: cleanQaAnswer(extractQaAssistantText(data)) || '未返回内容', cites, raw: data })
  } catch (error) {
    next(error)
  }
})

app.post('/api/qa/chat/stream', async (req, res, next) => {
  try {
    const messages = normalizeMessages(req.body)
    if (!messages.length) {
      res.status(400).json({ error: '请输入问题' })
      return
    }

    if (isMockMode()) {
      res.writeHead(200, sseHeaders())
      const last = messages.at(-1)?.content || ''
      const answer = `模拟回答：已收到“${last}”。切换到内网并配置 QA_API_BASE_URL 后将调用制造一厂知识问答助手。`
      for (const chunk of splitAnswerForMock(answer)) {
        writeSse(res, { type: 'answer', answer: chunk })
        await delay(80)
      }
      writeSse(res, { type: 'done', answer, cites: [] })
      res.end()
      return
    }

    const qaRequest = await buildQaChatRequest(req.body, messages)
    const response = await fetch(qaRequest.url, qaRequest.options)

    if (!response.ok) {
      const data = await parseQaResponse(response)
      res.status(response.status).json({ error: data?.error || data?.message || '问答助手接口调用失败' })
      return
    }

    res.writeHead(200, sseHeaders())

    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const data = await safeJson(response)
      const answer = cleanQaAnswer(extractQaAssistantText(data)) || '未返回内容'
      const cites = normalizeQaCites(extractQaCites(data), qaRequest.baseUrl, qaRequest.token)
      writeSse(res, { type: 'answer', answer })
      writeSse(res, { type: 'done', answer, cites })
      res.end()
      return
    }

    await streamQaResponse(response, res, qaRequest)
  } catch (error) {
    if (res.headersSent) {
      writeSse(res, { type: 'error', error: error.message || '问答助手流式调用失败' })
      res.end()
      return
    }
    next(error)
  }
})

app.post('/api/translate', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: '请选择要翻译的文件' })
      return
    }
    const direction = req.body?.direction === 'zh-en' ? 'zh-en' : 'en-zh'
    const extracted = await extractDocument(req.file.path, req.file.originalname, convertedDir)
    const glossaries = all(
      `SELECT id, original_name AS originalName, text_content AS textContent
       FROM glossaries
       ORDER BY datetime(created_at) DESC`,
    )
    const glossaryText = glossaries
      .map((item, index) => `【词库 ${index + 1}: ${item.originalName}】\n${item.textContent}`)
      .join('\n\n')
      .slice(0, 12000)

    const translatedText = await translateText(extracted.text, direction, glossaryText)
    const translatedHtml = textToHtml(translatedText)
    const resultName = `${Date.now()}-${crypto.randomUUID()}-translated.docx`
    const resultPath = path.join(resultsDir, resultName)
    await createDocxFromText({
      title: `${req.file.originalname} 翻译结果`,
      text: translatedText,
      outputPath: resultPath,
      direction,
      glossaryNames: glossaries.map((item) => item.originalName),
    })

    run(
      `INSERT INTO translations
        (original_name, stored_name, converted_name, result_name, direction,
         original_html, translated_html, glossary_names, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.file.originalname,
        req.file.filename,
        path.basename(extracted.convertedPath),
        resultName,
        direction,
        extracted.html,
        translatedHtml,
        JSON.stringify(glossaries.map((item) => item.originalName)),
        now(),
      ],
    )
    const id = get('SELECT id FROM translations ORDER BY id DESC LIMIT 1').id
    res.json({
      ok: true,
      translation: {
        id,
        originalName: req.file.originalname,
        direction,
        originalHtml: extracted.html,
        translatedHtml,
        glossaryNames: glossaries.map((item) => item.originalName),
        downloadUrl: `/api/translations/${id}/download`,
      },
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/pdf-to-word', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: '请选择要转换的 PDF 文件' })
      return
    }
    if (path.extname(req.file.originalname || '').toLowerCase() !== '.pdf') {
      await removeFile(req.file.path)
      res.status(400).json({ error: 'PDF 转 Word 助手仅支持 PDF 文件' })
      return
    }
    const task = createDocumentTask({
      type: 'pdf-to-word',
      originalName: req.file.originalname,
      storedName: req.file.filename,
      stage: '文件已上传，等待处理',
    })
    setImmediate(() => {
      processPdfToWordTask(task.id).catch((error) => failDocumentTask(task.id, error))
    })
    res.status(202).json({ ok: true, task })
  } catch (error) {
    next(error)
  }
})

app.post('/api/standards/plant-1', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: '请选择要解读的 Word 文件' })
      return
    }
    if (path.extname(req.file.originalname || '').toLowerCase() !== '.docx') {
      await removeFile(req.file.path)
      res.status(400).json({ error: '标准解读助手仅支持 DOCX 文件' })
      return
    }
    const task = createDocumentTask({
      type: 'standard-plant-1',
      originalName: req.file.originalname,
      storedName: req.file.filename,
      stage: '文件已上传，等待解读',
    })
    setImmediate(() => {
      processStandardTask(task.id, 'standard-plant-1').catch((error) => failDocumentTask(task.id, error))
    })
    res.status(202).json({ ok: true, task })
  } catch (error) {
    next(error)
  }
})

app.get('/api/document-tasks/:id', (req, res) => {
  const task = getDocumentTask(req.params.id)
  if (!task) {
    res.status(404).json({ error: '未找到该处理任务' })
    return
  }
  res.json({ task })
})

app.get('/api/document-tasks/:id/download', (req, res) => {
  const task = getDocumentTask(req.params.id)
  if (!task || task.status !== 'completed' || !task.resultName) {
    res.status(404).json({ error: '结果文件尚未生成' })
    return
  }
  const filePath = path.join(resultsDir, task.resultName)
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: '结果文件不存在' })
    return
  }
  const suffix = task.type === 'pdf-to-word' ? '转换结果' : '标准解读'
  const baseName = path.parse(task.originalName).name
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName}-${suffix}.docx`)}`)
  res.download(filePath)
})

app.get('/api/translations/:id/download', (req, res) => {
  const row = get('SELECT result_name AS resultName, original_name AS originalName FROM translations WHERE id = ?', [
    req.params.id,
  ])
  if (!row) {
    res.status(404).json({ error: '未找到翻译结果' })
    return
  }
  const filePath = path.join(resultsDir, row.resultName)
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: '翻译文件不存在' })
    return
  }
  const safeName = encodeURIComponent(`${row.originalName}-translated.docx`)
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeName}`)
  res.download(filePath)
})

const distDir = path.join(rootDir, 'dist')
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

app.use((error, _req, res, _next) => {
  console.error(error)
  res.status(error.status || 500).json({
    error: error.message || '服务处理失败',
  })
})

app.listen(port, '0.0.0.0', () => {
  console.log(`AI助手网页服务已启动: http://localhost:${port}`)
})

async function ensureDirectories() {
  await Promise.all(
    [storageDir, uploadDir, glossaryDir, convertedDir, resultsDir].map((dir) =>
      fsp.mkdir(dir, { recursive: true }),
    ),
  )
}

async function openDatabase() {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(rootDir, 'node_modules', 'sql.js', 'dist', file),
  })
  if (fs.existsSync(dbPath)) {
    return new SQL.Database(await fsp.readFile(dbPath))
  }
  return new SQL.Database()
}

function ensureSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      reply TEXT,
      created_at TEXT NOT NULL,
      replied_at TEXT
    );

    CREATE TABLE IF NOT EXISTS glossaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      converted_name TEXT NOT NULL,
      text_content TEXT NOT NULL,
      html_content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS translations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      converted_name TEXT NOT NULL,
      result_name TEXT NOT NULL,
      direction TEXT NOT NULL,
      original_html TEXT NOT NULL,
      translated_html TEXT NOT NULL,
      glossary_names TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assistant_prompts (
      assistant_id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL,
      stage TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      result_name TEXT,
      preview_html TEXT,
      error TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  for (const assistantId of ['standard-plant-1', 'standard-plant-2', 'standard-plant-3']) {
    db.run(
      `INSERT OR IGNORE INTO assistant_prompts (assistant_id, prompt, updated_at) VALUES (?, ?, ?)`,
      [assistantId, defaultStandardPrompt, now()],
    )
  }
  db.run(
    `UPDATE document_tasks SET status = 'failed', error = '服务重启，任务已中断，请重新上传',
       stage = '任务中断', updated_at = ? WHERE status IN ('queued', 'processing')`,
    [now()],
  )
  saveDatabase()
}

function run(sql, params = []) {
  db.run(sql, params)
  saveDatabase()
}

function all(sql, params = []) {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  const rows = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject())
  }
  stmt.free()
  return rows
}

function get(sql, params = []) {
  return all(sql, params)[0] || null
}

function saveDatabase() {
  fs.writeFileSync(dbPath, Buffer.from(db.export()))
}

function now() {
  return new Date().toISOString()
}

function recordEvent(type) {
  run('INSERT INTO events (type, created_at) VALUES (?, ?)', [type, now()])
}

function getStats() {
  const events = all('SELECT type, created_at AS createdAt FROM events')
  const today = new Date()
  const visits = events.filter((event) => event.type === 'visit')
  return {
    qaUses: events.filter((event) => event.type === 'qa_click').length,
    translationUses: events.filter((event) => event.type === 'translation_click').length,
    pdfUses: events.filter((event) => event.type === 'pdf_click').length,
    standardUses: events.filter((event) => event.type === 'standard_click').length,
    active: {
      day: visits.filter((event) => isSameDay(event.createdAt, today)).length,
      month: visits.filter((event) => isSameMonth(event.createdAt, today)).length,
      year: visits.filter((event) => isSameYear(event.createdAt, today)).length,
    },
  }
}

function isSameDay(value, target) {
  const date = new Date(value)
  return date.getFullYear() === target.getFullYear() && date.getMonth() === target.getMonth() && date.getDate() === target.getDate()
}

function isSameMonth(value, target) {
  const date = new Date(value)
  return date.getFullYear() === target.getFullYear() && date.getMonth() === target.getMonth()
}

function isSameYear(value, target) {
  const date = new Date(value)
  return date.getFullYear() === target.getFullYear()
}

function requireAdmin(req, res, next) {
  if (!req.session?.isAdmin) {
    res.status(401).json({ error: '请先以管理员身份登录' })
    return
  }
  next()
}

function normalizeMessages(body) {
  if (Array.isArray(body?.messages)) {
    return body.messages
      .filter((item) => item && typeof item.content === 'string')
      .map((item) => ({ role: item.role || 'user', content: item.content }))
  }
  const message = String(body?.message || '').trim()
  return message ? [{ role: 'user', content: message }] : []
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || '').trim()
  return trimmed ? trimmed.replace(/\/+$/, '') : ''
}

function buildJsonHeaders(token) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

function resolveQaAccount(body) {
  const code = String(body?.oaCode || body?.code || '').trim()
  if (code) {
    return decodePossibleBase64(code)
  }
  return String(process.env.QA_DEFAULT_ACCOUNT || '').trim()
}

function decodePossibleBase64(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const couldBeBase64 = /^[A-Za-z0-9+/=]+$/.test(normalized) && normalized.length % 4 !== 1
  if (!couldBeBase64) return value
  try {
    const decoded = Buffer.from(normalized, 'base64').toString('utf8').trim()
    if (decoded && /^[\w@.\-\u4e00-\u9fa5]+$/.test(decoded)) {
      return decoded
    }
  } catch {
    return value
  }
  return value
}

async function getQaAccessToken(baseUrl, account) {
  const cached = qaTokenCache.get(account)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token
  }
  const clientId = process.env.QA_AUTH_CLIENT_ID
  const clientSecret = process.env.QA_AUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('请先在 .env 中配置 QA_AUTH_CLIENT_ID 和 QA_AUTH_CLIENT_SECRET')
  }

  const response = await fetch(`${baseUrl}/api/authentication/v1/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: JSON.stringify({ account }),
    ...qaFetchOptions(),
  })
  const data = await safeJson(response)
  if (!response.ok || !data?.access_token) {
    throw new Error(data?.error || data?.message || '获取知识问答助手 access_token 失败')
  }

  const expiresIn = Number(data.expires_in || 3000)
  qaTokenCache.set(account, {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000,
  })
  return data.access_token
}

function qaFetchOptions() {
  return insecureQaDispatcher ? { dispatcher: insecureQaDispatcher } : {}
}

async function buildQaChatRequest(body, messages) {
  const baseUrl = normalizeBaseUrl(process.env.QA_API_BASE_URL)
  if (!baseUrl) {
    throw new Error('请先在 .env 中配置 QA_API_BASE_URL')
  }

  const account = resolveQaAccount(body)
  if (!account) {
    throw new Error('未获取到 OA 账号，请从 OA 入口访问本系统，或在 .env 中配置 QA_DEFAULT_ACCOUNT 用于测试')
  }

  const token = await getQaAccessToken(baseUrl, account)
  const query = messages.at(-1)?.content || ''
  return {
    baseUrl,
    token,
    url: `${baseUrl}/api/intelli-search/v2/bots/${process.env.QA_BOT_ID || defaultQaBotId}/chat`,
    options: {
      method: 'POST',
      headers: buildJsonHeaders(token),
      body: JSON.stringify({
        conversation_id: crypto.randomUUID(),
        query,
        times: 0,
        parent_qa_id: '1',
      }),
      ...qaFetchOptions(),
    },
  }
}

async function streamQaResponse(response, res, qaRequest) {
  const decoder = new TextDecoder()
  let buffer = ''
  let lastAnswer = ''
  let finalData = null

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const result = consumeQaEventLines(buffer)
    buffer = result.remainder
    for (const event of result.events) {
      const data = parseQaEvent(event)
      if (!data) continue
      const answer = cleanQaAnswer(extractQaAssistantText(data))
      if (answer || extractQaCites(data).length > 0) {
        finalData = data
      }
      if (answer && answer !== lastAnswer) {
        lastAnswer = answer
        writeSse(res, { type: 'answer', answer })
      }
    }
  }

  buffer += decoder.decode()
  const result = consumeQaEventLines(`${buffer}\n`)
  for (const event of result.events) {
    const data = parseQaEvent(event)
    if (!data) continue
    const answer = cleanQaAnswer(extractQaAssistantText(data))
    if (answer || extractQaCites(data).length > 0) {
      finalData = data
    }
    if (answer) lastAnswer = answer
  }

  const cites = normalizeQaCites(extractQaCites(finalData), qaRequest.baseUrl, qaRequest.token)
  writeSse(res, { type: 'done', answer: lastAnswer, cites })
  res.end()
}

function consumeQaEventLines(value) {
  const lines = value.split(/\r?\n/)
  const remainder = lines.pop() || ''
  const events = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed === 'event: end') continue
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
    if (!payload || payload === 'event: end' || payload === '[DONE]') continue
    events.push(payload)
  }
  return { events, remainder }
}

function parseQaEvent(payload) {
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  }
}

function writeSse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function splitAnswerForMock(answer) {
  const chunks = []
  for (let index = 1; index <= answer.length; index += 8) {
    chunks.push(answer.slice(0, index + 7))
  }
  return chunks
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function parseQaResponse(response) {
  const contentType = response.headers.get('content-type') || ''
  const text = await response.text()
  if (!text) return null

  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text)
    } catch {
      return { message: text }
    }
  }

  const events = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed === 'event: end') continue
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
    if (!payload || payload === 'event: end') continue
    try {
      events.push(JSON.parse(payload))
    } catch {
      events.push({ message: payload })
    }
  }

  return [...events].reverse().find((item) => extractQaAssistantText(item)) || events.at(-1) || { message: text }
}

async function safeJson(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

function extractQaAssistantText(data) {
  return (
    data?.result?.answer?.text ||
    data?.result?.skills_process?.[0]?.text ||
    data?.answer?.text ||
    data?.answer ||
    data?.message ||
    ''
  )
}

function extractQaCites(data) {
  return data?.result?.answer?.cites || data?.answer?.cites || []
}

function cleanQaAnswer(value) {
  return stripHtmlTags(
    decodeHtmlEntities(
      String(value || '')
        .replace(/<think[\s\S]*?(<\/think>|$)/gi, '')
        .replace(/<\/?think>/gi, '')
        .replace(/<i\b[^>]*>(.*?)<\/i>/gi, '[$1]')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p>/gi, '\n\n')
        .replace(/<\/?(p|div|section|article|ul|ol|li|span|strong|em|b)\b[^>]*>/gi, '\n'),
    ),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeQaCites(cites, baseUrl, token) {
  if (!Array.isArray(cites)) return []
  return cites
    .filter((cite) => cite && cite.doc_id)
    .map((cite, index) => {
      const page = getCitePage(cite)
      const docName = `${cite.doc_name || `引用文档${index + 1}`}${cite.ext_type || ''}`
      return {
        docId: cite.doc_id,
        docName,
        page,
        snippet: cleanQaAnswer(cite.content || ''),
        openUrl: buildQaFileUrl({ baseUrl, token, cite, page }),
      }
    })
}

function getCitePage(cite) {
  const page = cite?.slices?.[0]?.pages?.[0]
  return Number.isFinite(Number(page)) ? Number(page) : 1
}

function buildQaFileUrl({ baseUrl, token, cite, page }) {
  const name = encodeURIComponent(cite.doc_name || '引用文档')
  const extraData = encodeURIComponent(JSON.stringify({ force_read: true }))
  return `${baseUrl}/anyshare/webfoxitreader?docid=${encodeURIComponent(cite.doc_id)}&tokenid=${encodeURIComponent(token)}&name=${name}&isShowActionMenuInSdk=false&extraData=${extraData}&page=${page}`
}

function stripHtmlTags(value) {
  return String(value || '').replace(/<[^>]+>/g, '')
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
}

async function extractDocument(filePath, originalName, outputDir) {
  const ext = path.extname(originalName || filePath).toLowerCase()
  if (ext === '.docx') {
    const buffer = await fsp.readFile(filePath)
    const [{ value: text }, { value: html }] = await Promise.all([
      mammoth.extractRawText({ buffer }),
      mammoth.convertToHtml({ buffer }),
    ])
    const convertedPath = path.join(outputDir, `${Date.now()}-${crypto.randomUUID()}-converted.docx`)
    await fsp.copyFile(filePath, convertedPath)
    return {
      text: cleanText(text),
      html: html || textToHtml(text),
      convertedPath,
    }
  }

  if (ext === '.pdf') {
    const buffer = await fsp.readFile(filePath)
    const parser = new PDFParse({ data: buffer })
    const result = await parser.getText()
    await parser.destroy?.()
    const text = cleanText(result.text || '')
    const convertedPath = path.join(outputDir, `${Date.now()}-${crypto.randomUUID()}-converted.docx`)
    await createDocxFromText({ title: originalName, text, outputPath: convertedPath })
    return {
      text,
      html: textToHtml(text),
      convertedPath,
    }
  }

  throw new Error('当前支持 PDF 和 DOCX 文件。.doc 文件请先另存为 .docx 后上传。')
}

async function translateText(text, direction, glossaryText) {
  const sourceText = cleanText(text)
  if (!sourceText) {
    throw new Error('文件中没有提取到可翻译文本')
  }

  const chunks = splitText(sourceText, 4500)
  const translated = []
  for (const [index, chunk] of chunks.entries()) {
    const prompt = buildTranslatePrompt({ chunk, direction, glossaryText, index, total: chunks.length })
    const result = await callSharedModel({
      purpose: `translation:${index + 1}/${chunks.length}`,
      messages: [{ role: 'user', content: prompt }],
      mockContent: `[模拟翻译结果]\n${chunk}`,
    })
    translated.push(stripModelThinking(result.content))
  }
  return translated.join('\n\n')
}

function buildTranslatePrompt({ chunk, direction, glossaryText, index, total }) {
  const directionText = direction === 'zh-en' ? '中文翻译为英文' : '英文翻译为中文'
  return [
    '你是企业内网文档翻译助手。请严格保留原文的段落顺序、编号、表格行列含义和专业术语。',
    `翻译方向：${directionText}。`,
    `当前片段：${index + 1}/${total}。`,
    '如果提供了标准词库，请优先按词库术语翻译；不要解释，不要添加总结，只输出译文。',
    glossaryText ? `标准词库：\n${glossaryText}` : '标准词库：无。',
    `待翻译文本：\n${chunk}`,
  ].join('\n\n')
}

function splitText(text, maxLength) {
  const paragraphs = text.split(/\n{2,}/)
  const chunks = []
  let current = ''
  for (const paragraph of paragraphs) {
    if ((current + '\n\n' + paragraph).length > maxLength && current) {
      chunks.push(current)
      current = paragraph
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph
    }
  }
  if (current) chunks.push(current)
  return chunks
}

function createDocumentTask({ type, originalName, storedName, stage }) {
  const id = crypto.randomUUID()
  const timestamp = now()
  run(
    `INSERT INTO document_tasks
      (id, type, status, progress, stage, original_name, stored_name, created_at, updated_at)
     VALUES (?, ?, 'queued', 0, ?, ?, ?, ?, ?)`,
    [id, type, stage, originalName, storedName, timestamp, timestamp],
  )
  return getDocumentTask(id)
}

function getDocumentTask(id) {
  const row = get(
    `SELECT id, type, status, progress, stage, original_name AS originalName,
      stored_name AS storedName, result_name AS resultName, preview_html AS previewHtml,
      error, metadata_json AS metadataJson, created_at AS createdAt, updated_at AS updatedAt
     FROM document_tasks WHERE id = ?`,
    [id],
  )
  if (!row) return null
  let metadata = {}
  try {
    metadata = row.metadataJson ? JSON.parse(row.metadataJson) : {}
  } catch {
    metadata = {}
  }
  return {
    ...row,
    progress: Number(row.progress || 0),
    metadata,
    downloadUrl: row.status === 'completed' ? `/api/document-tasks/${row.id}/download` : null,
    metadataJson: undefined,
  }
}

function updateDocumentTask(id, patch) {
  const fields = []
  const params = []
  const fieldMap = {
    status: 'status',
    progress: 'progress',
    stage: 'stage',
    resultName: 'result_name',
    previewHtml: 'preview_html',
    error: 'error',
  }
  for (const [key, column] of Object.entries(fieldMap)) {
    if (Object.hasOwn(patch, key)) {
      fields.push(`${column} = ?`)
      params.push(patch[key])
    }
  }
  if (Object.hasOwn(patch, 'metadata')) {
    fields.push('metadata_json = ?')
    params.push(JSON.stringify(patch.metadata || {}))
  }
  fields.push('updated_at = ?')
  params.push(now(), id)
  run(`UPDATE document_tasks SET ${fields.join(', ')} WHERE id = ?`, params)
}

function failDocumentTask(id, error) {
  console.error(`文档任务 ${id} 失败:`, error)
  updateDocumentTask(id, {
    status: 'failed',
    stage: '处理失败',
    error: String(error?.message || '文档处理失败').slice(0, 2000),
  })
}

async function processPdfToWordTask(taskId) {
  const task = getDocumentTask(taskId)
  if (!task) return
  updateDocumentTask(taskId, { status: 'processing', progress: 3, stage: '正在读取 PDF' })
  const filePath = path.join(uploadDir, task.storedName)
  const parser = new PDFParse({ data: await fsp.readFile(filePath) })
  const diagnostics = []
  try {
    const textResult = await parser.getText()
    const pages = textResult.pages || []
    if (!pages.length) throw new Error('PDF 中没有可处理的页面')
    updateDocumentTask(taskId, {
      progress: 10,
      stage: `已读取 ${pages.length} 页，开始逐页识别与排版`,
      metadata: { totalPages: pages.length },
    })

    const renderedPages = []
    for (const [index, page] of pages.entries()) {
      const pageNumber = page.num || index + 1
      const sourceText = cleanText(page.text || '')
      let result
      if (sourceText.length >= 80) {
        result = await callSharedModel({
          purpose: `pdf-layout:text-page-${pageNumber}`,
          messages: [{ role: 'user', content: buildPdfTextPrompt(sourceText, pageNumber, pages.length) }],
          mockContent: `## 第 ${pageNumber} 页\n\n${sourceText}`,
        })
      } else {
        updateDocumentTask(taskId, {
          progress: Math.max(10, Math.floor(10 + (index / pages.length) * 78)),
          stage: `第 ${pageNumber}/${pages.length} 页文本较少，正在进行图像识别`,
        })
        const screenshot = await parser.getScreenshot({ partial: [pageNumber], desiredWidth: 1800 })
        const imageUrl = screenshot.pages?.[0]?.dataUrl
        if (!imageUrl) throw new Error(`第 ${pageNumber} 页图像渲染失败`)
        result = await callSharedModel({
          purpose: `pdf-ocr:image-page-${pageNumber}`,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: buildPdfImagePrompt(pageNumber, pages.length) },
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            },
          ],
          mockContent: `## 第 ${pageNumber} 页\n\n[模拟模式：该页需要内网模型进行图像识别]`,
        })
      }
      diagnostics.push(result.diagnostics)
      renderedPages.push(stripModelThinking(result.content))
      updateDocumentTask(taskId, {
        progress: Math.floor(10 + ((index + 1) / pages.length) * 78),
        stage: `已完成第 ${pageNumber}/${pages.length} 页`,
      })
    }

    updateDocumentTask(taskId, { progress: 92, stage: '正在生成 Word 文档' })
    const markdown = renderedPages.join('\n\n---\n\n')
    const resultName = `${Date.now()}-${crypto.randomUUID()}-pdf-to-word.docx`
    await createDocxFromMarkdown({
      title: `${path.parse(task.originalName).name} 转换结果`,
      markdown,
      outputPath: path.join(resultsDir, resultName),
    })
    updateDocumentTask(taskId, {
      status: 'completed',
      progress: 100,
      stage: '转换完成，可以下载 Word',
      resultName,
      previewHtml: markdownToHtml(markdown),
      metadata: buildTaskDiagnostics({ diagnostics, totalPages: pages.length }),
      error: null,
    })
  } finally {
    await parser.destroy?.()
  }
}

async function processStandardTask(taskId, assistantId) {
  const task = getDocumentTask(taskId)
  if (!task) return
  updateDocumentTask(taskId, { status: 'processing', progress: 5, stage: '正在读取 Word 文档' })
  const extracted = await extractDocument(
    path.join(uploadDir, task.storedName),
    task.originalName,
    convertedDir,
  )
  if (!extracted.text) throw new Error('Word 文档中没有提取到可解读内容')
  const promptRow = get('SELECT prompt FROM assistant_prompts WHERE assistant_id = ?', [assistantId])
  const prompt = promptRow?.prompt || defaultStandardPrompt
  const chunks = splitText(extracted.text, 12000)
  const interpreted = []
  const diagnostics = []
  for (const [index, chunk] of chunks.entries()) {
    updateDocumentTask(taskId, {
      progress: Math.floor(10 + (index / chunks.length) * 78),
      stage: `正在解读第 ${index + 1}/${chunks.length} 个文档片段`,
      metadata: { totalChunks: chunks.length },
    })
    const result = await callSharedModel({
      purpose: `standard-plant-1:${index + 1}/${chunks.length}`,
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content: [
            `这是文档第 ${index + 1}/${chunks.length} 个片段。请按系统提示词解读，并保持与前后片段可合并的 Markdown 层级。`,
            '文档内容如下：',
            chunk,
          ].join('\n\n'),
        },
      ],
      mockContent: `# 模拟标准解读（片段 ${index + 1}）\n\n${chunk}`,
    })
    diagnostics.push(result.diagnostics)
    interpreted.push(stripModelThinking(result.content))
  }

  updateDocumentTask(taskId, { progress: 92, stage: '正在排版并生成 Word 文档' })
  const markdown = interpreted.join('\n\n')
  const resultName = `${Date.now()}-${crypto.randomUUID()}-standard-plant-1.docx`
  await createDocxFromMarkdown({
    title: `${path.parse(task.originalName).name} 标准解读（一厂）`,
    markdown,
    outputPath: path.join(resultsDir, resultName),
  })
  updateDocumentTask(taskId, {
    status: 'completed',
    progress: 100,
    stage: '解读完成，可以下载 Word',
    resultName,
    previewHtml: markdownToHtml(markdown),
    metadata: buildTaskDiagnostics({ diagnostics, totalChunks: chunks.length }),
    error: null,
  })
}

function buildPdfTextPrompt(text, pageNumber, totalPages) {
  return [
    '你是专业的 PDF 转 Word 文档识别与排版助手。',
    `以下是第 ${pageNumber}/${totalPages} 页提取出的文本。请纠正明显的断行和识别错误，并恢复标题、段落、编号、列表、表格和公式结构。`,
    '只输出该页整理后的 Markdown 正文。不得总结、删减或编造内容；数值、单位、公式和专有名词必须忠于原文。',
    text,
  ].join('\n\n')
}

function buildPdfImagePrompt(pageNumber, totalPages) {
  return [
    `请识别这张 PDF 第 ${pageNumber}/${totalPages} 页的全部可见内容，并恢复适合 Word 的排版。`,
    '输出 Markdown 正文，保留标题、段落、编号、列表、表格、公式、数值和单位。',
    '扫描质量可能较差；无法确认的字用〔无法辨认〕标记，不得猜测或补写，不要输出解释和思考过程。',
  ].join('\n')
}

function buildTaskDiagnostics({ diagnostics, ...counts }) {
  const responses = diagnostics.length
  const reasoningResponses = diagnostics.filter(
    (item) => item.responseHasReasoning || item.contentContainsThinkTag,
  ).length
  return {
    ...counts,
    modelCalls: responses,
    thinkingDisabledRequested: true,
    reasoningResponses,
    thinkingVerification:
      reasoningResponses === 0
        ? '请求已关闭思考，且模型响应中未发现 reasoning 字段或 think 标签'
        : `请求已关闭思考，但 ${reasoningResponses} 次响应仍检测到思考内容标记`,
  }
}

function stripModelThinking(value) {
  return String(value || '')
    .replace(/<think[\s\S]*?(<\/think>|$)/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim()
}

async function removeFile(filePath) {
  try {
    await fsp.unlink(filePath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function createDocxFromText({ title, text, outputPath, direction, glossaryNames = [] }) {
  const children = [
    new Paragraph({
      text: title || '文档',
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 240 },
    }),
  ]

  if (direction) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `翻译方向：${direction === 'zh-en' ? '汉译英' : '英译汉'}`, bold: true }),
        ],
        spacing: { after: 160 },
      }),
    )
  }

  if (glossaryNames.length) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `使用词库：${glossaryNames.join('、')}`, italics: true })],
        spacing: { after: 220 },
      }),
    )
  }

  const blocks = text.split(/\n{2,}/).filter(Boolean)
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean)
    if (looksLikeTable(lines)) {
      children.push(createSimpleTable(lines))
    } else {
      children.push(
        new Paragraph({
          children: [new TextRun(block.replace(/\n/g, '\n'))],
          spacing: { after: 180 },
        }),
      )
    }
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  })
  await fsp.writeFile(outputPath, await Packer.toBuffer(doc))
}

async function createDocxFromMarkdown({ title, markdown, outputPath }) {
  const children = [
    new Paragraph({
      text: title || '文档处理结果',
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 260 },
    }),
  ]
  const lines = cleanText(markdown).split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index].trim()
    if (!line) {
      index += 1
      continue
    }
    if (isMarkdownTableLine(line)) {
      const tableLines = []
      while (index < lines.length && isMarkdownTableLine(lines[index].trim())) {
        tableLines.push(lines[index].trim())
        index += 1
      }
      const normalized = tableLines.filter((item) => !isMarkdownSeparator(item))
      if (normalized.length) children.push(createMarkdownTable(normalized))
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      const headingLevels = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
      ]
      children.push(
        new Paragraph({
          children: markdownInlineRuns(heading[2]),
          heading: headingLevels[heading[1].length - 1],
          spacing: { before: 180, after: 100 },
        }),
      )
      index += 1
      continue
    }
    const bullet = line.match(/^[-*+]\s+(.+)$/)
    if (bullet) {
      children.push(
        new Paragraph({
          children: markdownInlineRuns(bullet[1]),
          bullet: { level: 0 },
          spacing: { after: 70 },
        }),
      )
      index += 1
      continue
    }
    if (/^---+$/.test(line)) {
      children.push(new Paragraph({ text: '', spacing: { before: 120, after: 120 } }))
      index += 1
      continue
    }
    const paragraphLines = [line]
    index += 1
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,4})\s+/.test(lines[index].trim()) &&
      !/^[-*+]\s+/.test(lines[index].trim()) &&
      !isMarkdownTableLine(lines[index].trim()) &&
      !/^---+$/.test(lines[index].trim())
    ) {
      paragraphLines.push(lines[index].trim())
      index += 1
    }
    children.push(
      new Paragraph({
        children: markdownInlineRuns(paragraphLines.join('\n')),
        spacing: { after: 150 },
      }),
    )
  }
  const doc = new Document({ sections: [{ properties: {}, children }] })
  await fsp.writeFile(outputPath, await Packer.toBuffer(doc))
}

function markdownInlineRuns(value) {
  const runs = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let cursor = 0
  for (const match of String(value).matchAll(pattern)) {
    if (match.index > cursor) runs.push(new TextRun(String(value).slice(cursor, match.index)))
    const token = match[0]
    if (token.startsWith('**')) {
      runs.push(new TextRun({ text: token.slice(2, -2), bold: true }))
    } else {
      runs.push(new TextRun({ text: token.slice(1, -1), font: 'Consolas' }))
    }
    cursor = match.index + token.length
  }
  if (cursor < String(value).length) runs.push(new TextRun(String(value).slice(cursor)))
  return runs.length ? runs : [new TextRun(String(value))]
}

function isMarkdownTableLine(line) {
  return line.startsWith('|') && line.endsWith('|') && line.split('|').length >= 4
}

function isMarkdownSeparator(line) {
  return /^\|?[\s:|-]+\|?$/.test(line) && line.includes('-')
}

function markdownCells(line) {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim())
}

function createMarkdownTable(lines) {
  const rows = lines.map((line) => {
    const cells = markdownCells(line)
    return new TableRow({
      children: cells.map(
        (cell) =>
          new TableCell({
            width: { size: 100 / Math.max(cells.length, 1), type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: markdownInlineRuns(cell) })],
          }),
      ),
    })
  })
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })
}

function looksLikeTable(lines) {
  return lines.length > 1 && lines.every((line) => line.includes('\t') || line.includes('|'))
}

function createSimpleTable(lines) {
  const rows = lines.map((line) => {
    const cells = line
      .split(line.includes('\t') ? '\t' : '|')
      .map((cell) => cell.trim())
      .filter(Boolean)
    return new TableRow({
      children: cells.map(
        (cell) =>
          new TableCell({
            width: { size: 100 / Math.max(cells.length, 1), type: WidthType.PERCENTAGE },
            children: [new Paragraph(cell)],
          }),
      ),
    })
  })
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
  })
}

function cleanText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

function textToHtml(text) {
  const blocks = cleanText(text)
    .split(/\n{2,}/)
    .filter(Boolean)
  if (!blocks.length) return '<p>未提取到内容</p>'
  return blocks
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br />')}</p>`)
    .join('')
}

function markdownToHtml(markdown) {
  const lines = cleanText(markdown).split('\n')
  const html = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index].trim()
    if (!line) {
      index += 1
      continue
    }
    if (isMarkdownTableLine(line)) {
      const tableLines = []
      while (index < lines.length && isMarkdownTableLine(lines[index].trim())) {
        tableLines.push(lines[index].trim())
        index += 1
      }
      const rows = tableLines.filter((item) => !isMarkdownSeparator(item))
      if (rows.length) {
        html.push(`<table><tbody>${rows.map((row) => `<tr>${markdownCells(row).map((cell) => `<td>${inlineMarkdownToHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      }
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      const level = Math.min(heading[1].length + 1, 5)
      html.push(`<h${level}>${inlineMarkdownToHtml(heading[2])}</h${level}>`)
    } else if (/^[-*+]\s+/.test(line)) {
      html.push(`<p>• ${inlineMarkdownToHtml(line.replace(/^[-*+]\s+/, ''))}</p>`)
    } else if (!/^---+$/.test(line)) {
      html.push(`<p>${inlineMarkdownToHtml(line)}</p>`)
    }
    index += 1
  }
  return html.join('') || '<p>未生成内容</p>'
}

function inlineMarkdownToHtml(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function isMockMode() {
  return String(process.env.MOCK_AI || '').toLowerCase() === 'true'
}

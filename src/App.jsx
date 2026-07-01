import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Bot,
  Database,
  Download,
  Factory,
  FileText,
  Languages,
  LogIn,
  LogOut,
  MessageSquare,
  Quote,
  Reply,
  Send,
  ShieldCheck,
  UploadCloud,
} from 'lucide-react'
import './App.css'

const emptyStats = {
  qaUses: 0,
  translationUses: 0,
  active: { day: 0, month: 0, year: 0 },
}

function App() {
  const [view, setView] = useState('home')
  const [stats, setStats] = useState(emptyStats)
  const [feedback, setFeedback] = useState([])
  const [me, setMe] = useState({ isAdmin: false, username: null })
  const [notice, setNotice] = useState('')
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [oaCode] = useState(() => new URLSearchParams(window.location.search).get('code') || '')

  useEffect(() => {
    async function boot() {
      await api('/api/visit', { method: 'POST' })
      await Promise.all([refreshStats(), refreshFeedback(), refreshMe()])
    }
    boot().catch((error) => setNotice(error.message))
  }, [])

  async function refreshStats() {
    const data = await api('/api/stats')
    setStats(data)
  }

  async function refreshFeedback() {
    const data = await api('/api/feedback')
    setFeedback(data.items || [])
  }

  async function refreshMe() {
    const data = await api('/api/me')
    setMe(data)
  }

  async function openAssistant(nextView) {
    await api(`/api/usage/${nextView === 'qa' ? 'qa' : 'translation'}`, { method: 'POST' })
    setView(nextView)
    refreshStats().catch(() => {})
  }

  async function logout() {
    await api('/api/logout', { method: 'POST' })
    setMe({ isAdmin: false, username: null })
    setNotice('管理员已退出')
  }

  const title = useMemo(() => {
    if (view === 'qa') return '制造一厂知识问答'
    if (view === 'translate') return '文档翻译助手'
    if (view === 'admin') return '管理控制台'
    return 'AI助手服务台'
  }, [view])

  return (
    <main className="shell">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => setView('home')}>
          <span className="brandMark"><Factory size={22} /></span>
          <span>
            <strong>AI助手服务台</strong>
            <small>Manufacturing Intelligence Hub</small>
          </span>
        </button>

        <nav className="nav">
          <button className={view === 'home' ? 'active' : ''} type="button" onClick={() => setView('home')}>
            <Activity size={17} /> 首页
          </button>
          <button className={view === 'qa' ? 'active' : ''} type="button" onClick={() => openAssistant('qa')}>
            <Bot size={17} /> 问答
          </button>
          <button className={view === 'translate' ? 'active' : ''} type="button" onClick={() => openAssistant('translate')}>
            <Languages size={17} /> 翻译
          </button>
        </nav>

        <div className="adminControls">
          {me.isAdmin ? (
            <>
              <button className={view === 'admin' ? 'active ghost' : 'ghost'} type="button" onClick={() => setView('admin')}>
                <ShieldCheck size={17} /> 管理
              </button>
              <button className="ghost iconText" type="button" onClick={logout} title="退出管理员">
                <LogOut size={17} /> 退出
              </button>
            </>
          ) : (
            <button className="ghost iconText" type="button" onClick={() => setLoginOpen(true)}>
              <LogIn size={17} /> 管理员登录
            </button>
          )}
        </div>
      </header>

      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice('')}>关闭</button>
        </div>
      )}

      <section className="headline">
        <div>
          <p className="eyebrow">内网 AI 助手工作台</p>
          <h1>{title}</h1>
        </div>
        <button className="primary" type="button" onClick={() => setFeedbackOpen(true)}>
          <MessageSquare size={18} /> 问题反馈
        </button>
      </section>

      {view === 'home' && (
        <HomeView
          stats={stats}
          feedback={feedback}
          isAdmin={me.isAdmin}
          onOpenAssistant={openAssistant}
          onReplySaved={refreshFeedback}
          setNotice={setNotice}
        />
      )}
      {view === 'qa' && <QaView setNotice={setNotice} oaCode={oaCode} />}
      {view === 'translate' && <TranslateView setNotice={setNotice} />}
      {view === 'admin' && (
        <AdminView
          isAdmin={me.isAdmin}
          onRequireLogin={() => setLoginOpen(true)}
          setNotice={setNotice}
        />
      )}

      {feedbackOpen && (
        <FeedbackDialog
          onClose={() => setFeedbackOpen(false)}
          onSaved={() => {
            setFeedbackOpen(false)
            refreshFeedback()
            setNotice('反馈已提交')
          }}
        />
      )}

      {loginOpen && (
        <LoginDialog
          onClose={() => setLoginOpen(false)}
          onLogin={async () => {
            setLoginOpen(false)
            await refreshMe()
            setNotice('管理员已登录')
          }}
        />
      )}
    </main>
  )
}

function HomeView({ stats, feedback, isAdmin, onOpenAssistant, onReplySaved, setNotice }) {
  return (
    <>
      <section className="metrics">
        <MetricCard label="问答助手使用" value={stats.qaUses} icon={<Bot size={21} />} tone="blue" />
        <MetricCard label="翻译助手使用" value={stats.translationUses} icon={<Languages size={21} />} tone="green" />
        <MetricCard label="今日活跃访问" value={stats.active.day} icon={<Activity size={21} />} tone="amber" />
        <MetricCard label="本月 / 本年活跃" value={`${stats.active.month} / ${stats.active.year}`} icon={<Database size={21} />} tone="slate" />
      </section>

      <section className="assistantGrid">
        <button className="assistantCard qa" type="button" onClick={() => onOpenAssistant('qa')}>
          <span className="assistantIcon"><Bot size={26} /></span>
          <span>
            <strong>制造一厂知识问答AI助手</strong>
            <small>连接既有知识问答接口，面向制造现场与业务知识查询。</small>
          </span>
        </button>
        <button className="assistantCard translate" type="button" onClick={() => onOpenAssistant('translate')}>
          <span className="assistantIcon"><Languages size={26} /></span>
          <span>
            <strong>翻译助手</strong>
            <small>基于内网 Qwen3-VL 模型，支持词库参考、文档对照和结果下载。</small>
          </span>
        </button>
      </section>

      <FeedbackBoard
        items={feedback}
        isAdmin={isAdmin}
        onReplySaved={onReplySaved}
        setNotice={setNotice}
      />
    </>
  )
}

function MetricCard({ label, value, icon, tone }) {
  return (
    <article className={`metric ${tone}`}>
      <div className="metricIcon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function FeedbackBoard({ items, isAdmin, onReplySaved, setNotice }) {
  const [replyingId, setReplyingId] = useState(null)
  const [replyText, setReplyText] = useState('')
  const [saving, setSaving] = useState(false)

  async function saveReply(id) {
    setSaving(true)
    try {
      await api(`/api/feedback/${id}/reply`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply: replyText }),
      })
      setReplyingId(null)
      setReplyText('')
      await onReplySaved()
      setNotice('回复已保存')
    } catch (error) {
      setNotice(error.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="feedbackPanel">
      <div className="sectionTitle">
        <div>
          <p className="eyebrow">Feedback Loop</p>
          <h2>问题意见</h2>
        </div>
        <span>{items.length} 条</span>
      </div>

      <div className="feedbackList">
        {items.length === 0 && <p className="empty">暂无反馈。</p>}
        {items.map((item) => (
          <article className="feedbackItem" key={item.id}>
            <div className="feedbackMain">
              <p>{item.content}</p>
              <time>{formatTime(item.createdAt)}</time>
            </div>
            {item.reply && (
              <div className="replyBlock">
                <strong>管理员回复</strong>
                <p>{item.reply}</p>
              </div>
            )}
            {isAdmin && (
              <div className="replyControls">
                {replyingId === item.id ? (
                  <>
                    <textarea value={replyText} onChange={(event) => setReplyText(event.target.value)} rows={3} autoFocus />
                    <button className="primary small" type="button" disabled={saving} onClick={() => saveReply(item.id)}>
                      <Send size={15} /> 保存回复
                    </button>
                  </>
                ) : (
                  <button className="ghost small" type="button" onClick={() => {
                    setReplyingId(item.id)
                    setReplyText(item.reply || '')
                  }}>
                    <Reply size={15} /> 回复
                  </button>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}

function QaView({ setNotice, oaCode }) {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: '你好，我是制造一厂知识问答AI助手。' },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  async function sendMessage(event) {
    event.preventDefault()
    const text = input.trim()
    if (!text) return
    const nextMessages = [...messages, { role: 'user', content: text }]
    const assistantIndex = nextMessages.length
    setMessages([...nextMessages, { role: 'assistant', content: '', cites: [], streaming: true }])
    setInput('')
    setLoading(true)
    try {
      const response = await fetch('/api/qa/chat/stream', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: nextMessages, oaCode }),
      })
      if (!response.ok) {
        const errorText = await response.text()
        const errorData = errorText ? JSON.parse(errorText) : {}
        throw new Error(errorData.error || '问答助手调用失败')
      }
      await readQaStream(response, (eventData) => {
        if (eventData.type === 'answer') {
          setMessages((current) => updateMessageAt(current, assistantIndex, {
            content: eventData.answer || '',
            streaming: true,
          }))
        }
        if (eventData.type === 'done') {
          setMessages((current) => updateMessageAt(current, assistantIndex, {
            content: eventData.answer || current[assistantIndex]?.content || '未返回内容',
            cites: eventData.cites || [],
            streaming: false,
          }))
        }
        if (eventData.type === 'error') {
          throw new Error(eventData.error || '问答助手流式调用失败')
        }
      })
    } catch (error) {
      setNotice(error.message)
      setMessages((current) => updateMessageAt(current, assistantIndex, {
        content: `调用失败：${error.message}`,
        cites: [],
        streaming: false,
      }))
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="workspace qaWorkspace">
      <div className="chatRail">
        {messages.map((message, index) => (
          <div className={`chatMessage ${message.role}`} key={`${message.role}-${index}`}>
            <span>{message.role === 'user' ? '用户' : '助手'}</span>
            <p className="chatText">
              {message.content || (message.streaming ? '正在生成回答...' : '')}
              {message.streaming && <i className="streamCursor" />}
            </p>
            {message.role === 'assistant' && message.cites?.length > 0 && (
              <div className="qaCites">
                <strong><Quote size={15} /> 引用资料</strong>
                <div className="qaCiteGrid">
                  {message.cites.map((cite) => (
                    <a className="qaCiteCard" href={cite.openUrl} target="_blank" rel="noreferrer" key={`${cite.docId}-${cite.page}`}>
                      <FileText size={17} />
                      <span>{cite.docName}</span>
                      <small>第 {cite.page} 页</small>
                      {cite.snippet && <em>{cite.snippet}</em>}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <form className="chatComposer" onSubmit={sendMessage}>
        <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="输入要咨询的问题" />
        <button className="primary" type="submit" disabled={loading}>
          <Send size={18} /> 发送
        </button>
      </form>
    </section>
  )
}

async function readQaStream(response, onEvent) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() || ''
    for (const part of parts) {
      const eventData = parseSseData(part)
      if (eventData) onEvent(eventData)
    }
  }

  buffer += decoder.decode()
  const eventData = parseSseData(buffer)
  if (eventData) onEvent(eventData)
}

function parseSseData(part) {
  const dataLine = part
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('data:'))
  if (!dataLine) return null
  try {
    return JSON.parse(dataLine.slice(5).trim())
  } catch {
    return null
  }
}

function updateMessageAt(messages, index, patch) {
  return messages.map((message, messageIndex) =>
    messageIndex === index ? { ...message, ...patch } : message,
  )
}

function TranslateView({ setNotice }) {
  const [direction, setDirection] = useState('en-zh')
  const [file, setFile] = useState(null)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)

  async function submit(event) {
    event.preventDefault()
    if (!file) {
      setNotice('请选择 PDF 或 DOCX 文件')
      return
    }
    const formData = new FormData()
    formData.append('file', file)
    formData.append('direction', direction)
    setLoading(true)
    setResult(null)
    try {
      const data = await api('/api/translate', { method: 'POST', body: formData })
      setResult(data.translation)
      setNotice('翻译完成')
    } catch (error) {
      setNotice(error.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="workspace translateWorkspace">
      <form className="uploadPanel" onSubmit={submit}>
        <label className="uploadZone">
          <UploadCloud size={32} />
          <strong>{file ? file.name : '选择待翻译文件'}</strong>
          <span>支持 PDF / DOCX，上传后自动提取并生成 Word 结果</span>
          <input type="file" accept=".pdf,.docx" onChange={(event) => setFile(event.target.files?.[0] || null)} />
        </label>
        <div className="segmented">
          <button type="button" className={direction === 'en-zh' ? 'active' : ''} onClick={() => setDirection('en-zh')}>
            英译汉
          </button>
          <button type="button" className={direction === 'zh-en' ? 'active' : ''} onClick={() => setDirection('zh-en')}>
            汉译英
          </button>
        </div>
        <button className="primary" type="submit" disabled={loading}>
          <Languages size={18} /> {loading ? '翻译中...' : '开始翻译'}
        </button>
      </form>

      {result && (
        <>
          <div className="translationMeta">
            <span><FileText size={16} /> {result.originalName}</span>
            <span>使用词库：{result.glossaryNames.length ? result.glossaryNames.join('、') : '未上传词库'}</span>
            <a className="downloadButton" href={result.downloadUrl}>
              <Download size={17} /> 下载 Word
            </a>
          </div>
          <div className="compareGrid">
            <DocumentPane title="原文内容" html={result.originalHtml} />
            <DocumentPane title="翻译内容" html={result.translatedHtml} />
          </div>
        </>
      )}
    </section>
  )
}

function DocumentPane({ title, html }) {
  return (
    <article className="documentPane">
      <h2>{title}</h2>
      <div className="documentBody" dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  )
}

function AdminView({ isAdmin, onRequireLogin, setNotice }) {
  const [glossaries, setGlossaries] = useState([])
  const [file, setFile] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (isAdmin) {
      loadGlossaries().catch((error) => setNotice(error.message))
    }
  }, [isAdmin, setNotice])

  async function loadGlossaries() {
    const data = await api('/api/glossaries')
    setGlossaries(data.items || [])
  }

  async function uploadGlossary(event) {
    event.preventDefault()
    if (!file) {
      setNotice('请选择词库文件')
      return
    }
    const formData = new FormData()
    formData.append('file', file)
    setLoading(true)
    try {
      await api('/api/glossaries', { method: 'POST', body: formData })
      setFile(null)
      await loadGlossaries()
      setNotice('词库已上传')
    } catch (error) {
      setNotice(error.message)
    } finally {
      setLoading(false)
    }
  }

  if (!isAdmin) {
    return (
      <section className="workspace adminLocked">
        <ShieldCheck size={42} />
        <h2>需要管理员身份</h2>
        <p>管理员登录后可上传标准词库，并回复首页反馈。</p>
        <button className="primary" type="button" onClick={onRequireLogin}>
          <LogIn size={18} /> 管理员登录
        </button>
      </section>
    )
  }

  return (
    <section className="workspace adminWorkspace">
      <form className="uploadPanel" onSubmit={uploadGlossary}>
        <label className="uploadZone compact">
          <UploadCloud size={28} />
          <strong>{file ? file.name : '上传标准词库'}</strong>
          <span>PDF / DOCX 文件将提取为翻译参考词库</span>
          <input type="file" accept=".pdf,.docx" onChange={(event) => setFile(event.target.files?.[0] || null)} />
        </label>
        <button className="primary" type="submit" disabled={loading}>
          <Database size={18} /> {loading ? '上传中...' : '上传词库'}
        </button>
      </form>

      <section className="glossaryList">
        <div className="sectionTitle">
          <div>
            <p className="eyebrow">Terminology Assets</p>
            <h2>标准词库文件</h2>
          </div>
          <span>{glossaries.length} 个</span>
        </div>
        {glossaries.length === 0 && <p className="empty">暂无词库文件。</p>}
        {glossaries.map((item) => (
          <article className="glossaryItem" key={item.id}>
            <FileText size={19} />
            <div>
              <strong>{item.originalName}</strong>
              <span>{formatTime(item.createdAt)}</span>
            </div>
          </article>
        ))}
      </section>
    </section>
  )
}

function FeedbackDialog({ onClose, onSaved }) {
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(event) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      onSaved()
    } catch (submitError) {
      setError(submitError.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title="提交问题反馈" onClose={onClose}>
      <form className="dialogForm" onSubmit={submit}>
        <textarea value={content} onChange={(event) => setContent(event.target.value)} rows={6} autoFocus />
        {error && <p className="formError">{error}</p>}
        <button className="primary" type="submit" disabled={saving}>
          <Send size={18} /> 提交反馈
        </button>
      </form>
    </Dialog>
  )
}

function LoginDialog({ onClose, onLogin }) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  async function submit(event) {
    event.preventDefault()
    setError('')
    try {
      await api('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      await onLogin()
    } catch (loginError) {
      setError(loginError.message)
    }
  }

  return (
    <Dialog title="管理员登录" onClose={onClose}>
      <form className="dialogForm" onSubmit={submit}>
        <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="管理员账号" />
        <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="管理员密码" type="password" autoFocus />
        {error && <p className="formError">{error}</p>}
        <button className="primary" type="submit">
          <ShieldCheck size={18} /> 登录
        </button>
      </form>
    </Dialog>
  )
}

function Dialog({ title, children, onClose }) {
  return (
    <div className="dialogBackdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialogHead">
          <h2>{title}</h2>
          <button type="button" onClick={onClose}>关闭</button>
        </div>
        {children}
      </section>
    </div>
  )
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'include', ...options })
  const text = await response.text()
  const data = text ? JSON.parse(text) : {}
  if (!response.ok) {
    throw new Error(data.error || data.message || '请求失败')
  }
  return data
}

function formatTime(value) {
  if (!value) return ''
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default App

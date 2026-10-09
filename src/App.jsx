import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  AlertCircle,
  Bot,
  BookOpenCheck,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  CircleUserRound,
  Database,
  Download,
  ExternalLink,
  Factory,
  FileWarning,
  FileOutput,
  FileText,
  Languages,
  KeyRound,
  LogIn,
  LogOut,
  MessageSquare,
  Pencil,
  Plus,
  Quote,
  RefreshCw,
  Reply,
  Save,
  ScanText,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import './App.css'
import { Pagination, PermissionsCenter, UsageStatistics } from './PlatformViews.jsx'

const anonymousUser = { authenticated: false, isAdmin: false, isSuperAdmin: false, permissions: [], roles: [] }
const assistantUsageTypes = { qa: 'qa', ragflow: 'ragflow', translate: 'translation', pdf: 'pdf', standard1: 'standard', standard2: 'standard', standard3: 'standard' }

function App() {
  return /^\/sso\/login\/?$/.test(window.location.pathname)?<SsoLoginView/>:<Workbench/>
}

function SsoLoginView() {
  const [error,setError]=useState('')
  const entry=useRef(null)
  if(!entry.current) {
    const tickets=new URLSearchParams(window.location.search).getAll('ticket')
    entry.current={ticket:tickets.length===1?tickets[0]:'',request:null}
  }
  useEffect(()=>{
    let active=true
    // StrictMode re-runs effects; share the exchange so a one-time ticket is checked only once.
    if(!entry.current.request) {
      window.history.replaceState(null,'','/sso/login')
      const params=new URLSearchParams({ticket:entry.current.ticket})
      entry.current.ticket=''
      entry.current.request=fetch(`/api/sso/login?${params}`,{credentials:'same-origin',cache:'no-store'}).then(async response=>{
        const data=await response.json()
        return {ok:response.ok,data}
      })
    }
    entry.current.request.then(({ok,data})=>{
      if(!active)return
      if(ok)window.location.replace('/')
      else if(data.code==='SSO_USER_NOT_FOUND'&&data.redirectUrl)window.location.replace(data.redirectUrl)
      else setError(data.error||'门户登录失败，请从门户重新进入')
    }).catch(()=>{if(active)setError('门户登录连接失败，请从门户重新进入或联系管理员')})
    return ()=>{active=false}
  },[])
  return <main className="ssoPage"><section className="ssoStatus" aria-live="polite" aria-busy={!error}><div className="ssoBrand"><span className="brandMark"><Factory size={22}/></span><strong>AI助手服务台</strong></div>
    <div className={`ssoStatusIcon ${error?'failed':''}`}>{error?<AlertCircle size={28}/>:<RefreshCw className="spinning" size={28}/>}</div><h1>{error?'门户登录未完成':'正在登录'}</h1><p>{error||'正在验证门户登录信息...'}</p>{error&&<a className="ghost" href="/"><ChevronLeft size={17}/>返回首页</a>}
  </section></main>
}

function Workbench() {
  const [view, setView] = useState('home')
  const [statsRevision, setStatsRevision] = useState(0)
  const [feedback, setFeedback] = useState({ items: [], total: 0, totalPages: 1 })
  const [feedbackPage, setFeedbackPage] = useState(1)
  const [feedbackRevision, setFeedbackRevision] = useState(0)
  const [me, setMe] = useState(anonymousUser)
  const [notice, setNotice] = useState('')
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [pendingView, setPendingView] = useState(null)
  const [oaCode] = useState(() => new URLSearchParams(window.location.search).get('code') || '')

  useEffect(() => {
    async function boot() {
      await api('/api/visit', { method: 'POST' })
      const initialUser = await api('/api/me')
      setMe(initialUser)
      if (initialUser.mustChangePassword) setPasswordOpen(true)
      setStatsRevision(value => value + 1)
    }
    boot().catch((error) => setNotice(error.message))
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    api(`/api/feedback?page=${feedbackPage}`, { signal: controller.signal }).then(setFeedback)
      .catch(error => { if (!controller.signal.aborted) setNotice(error.message) })
    return () => controller.abort()
  }, [feedbackPage, feedbackRevision])

  useEffect(() => {
    const requireLogin = () => { setMe(anonymousUser); setView('home'); setLoginOpen(true) }
    const requirePassword = () => { setPasswordOpen(true) }
    window.addEventListener('platform-login-required', requireLogin)
    window.addEventListener('platform-password-required', requirePassword)
    return () => { window.removeEventListener('platform-login-required', requireLogin); window.removeEventListener('platform-password-required', requirePassword) }
  }, [])

  async function refreshMe() {
    const data = await api('/api/me')
    setMe(data)
    if (data.mustChangePassword) setPasswordOpen(true)
    if (view === 'permissions' && !data.isSuperAdmin) setView('home')
    if (view === 'admin' && !data.isAdmin) setView('home')
    return data
  }

  async function openAssistant(nextView) {
    if (!me.authenticated) { setPendingView(nextView); setLoginOpen(true); return }
    if (me.mustChangePassword) { setPendingView(nextView); setPasswordOpen(true); return }
    try { await enterAssistant(nextView) } catch (error) { setNotice(error.message) }
  }

  async function enterAssistant(nextView) {
    const usageType = assistantUsageTypes[nextView]
    if (usageType) await api(`/api/usage/${usageType}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: createUsageRequestId() }) })
    setView(nextView)
    setStatsRevision(value => value + 1)
  }

  async function logout() {
    await api('/api/logout', { method: 'POST' })
    setMe(anonymousUser)
    setView('home')
    setPasswordOpen(false)
    setPendingView(null)
    setNotice('已退出登录')
  }

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
          <button className={view.startsWith('standard') ? 'active' : ''} type="button" onClick={() => openAssistant('standard1')}>
            <BookOpenCheck size={17} /> 标准解读
          </button>
          <button className={view === 'pdf' ? 'active' : ''} type="button" onClick={() => openAssistant('pdf')}>
            <FileOutput size={17} /> PDF 转 Word
          </button>
          <button className={view === 'translate' ? 'active' : ''} type="button" onClick={() => openAssistant('translate')}>
            <Languages size={17} /> 翻译
          </button>
          <button className={['qa', 'ragflow'].includes(view) ? 'active' : ''} type="button" onClick={() => openAssistant('qa')}>
            <Bot size={17} /> 问答
          </button>
        </nav>

        <div className="adminControls">
          <button className="primary" type="button" onClick={() => { if (!me.authenticated) setLoginOpen(true); else if (me.mustChangePassword) setPasswordOpen(true); else setFeedbackOpen(true) }}>
            <MessageSquare size={18} /> 问题反馈
          </button>
          {me.authenticated ? (
            <>
              {me.isAdmin && !me.mustChangePassword && <button className={view === 'admin' ? 'active ghost' : 'ghost'} type="button" onClick={() => setView('admin')} title="内容管理"><Settings2 size={17} />内容管理</button>}
              {me.isSuperAdmin && !me.mustChangePassword && <button className={view === 'permissions' ? 'active ghost' : 'ghost'} type="button" onClick={() => setView('permissions')}><ShieldCheck size={17} />权限中心</button>}
              <details className="accountMenu"><summary><CircleUserRound size={18} /><span>{me.name || me.username}</span><ChevronDown size={15} /></summary><div className="accountDropdown"><strong>{me.name}</strong><p>{me.username} · {me.departmentName}</p>{!me.builtin && <button className="ghost" type="button" onClick={() => setPasswordOpen(true)}><KeyRound size={16} />{me.authMethod==='portal'?'修改本平台密码':'修改密码'}</button>}<button className="ghost" type="button" onClick={() => logout().catch(error => setNotice(error.message))}><LogOut size={16} />退出登录</button></div></details>
            </>
          ) : (
            <button className="ghost iconText" type="button" onClick={() => setLoginOpen(true)}>
              <LogIn size={17} /> 登录
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

      {view === 'home' && (
        <HomeView
          statsRevision={statsRevision}
          feedback={feedback}
          feedbackPage={feedbackPage}
          onFeedbackPage={setFeedbackPage}
          isAdmin={me.isSuperAdmin}
          onOpenAssistant={openAssistant}
          onReplySaved={() => setFeedbackRevision(value => value + 1)}
          setNotice={setNotice}
        />
      )}
      {view === 'qa' && <QaView setNotice={setNotice} oaCode={oaCode} />}
      {view === 'ragflow' && <RagflowQaView setNotice={setNotice} />}
      {view === 'translate' && <TranslateView setNotice={setNotice} />}
      {view === 'pdf' && <PdfToWordView setNotice={setNotice} />}
      {view === 'standard1' && <StandardView plant={1} setNotice={setNotice} />}
      {view === 'standard2' && <StandardView plant={2} setNotice={setNotice} />}
      {view === 'standard3' && <StandardView plant={3} setNotice={setNotice} />}
      {view === 'permissions' && <PermissionsCenter api={api} me={me} setNotice={setNotice} onUserChanged={refreshMe} />}
      {view === 'admin' && !me.mustChangePassword && (
        <AdminView
          me={me}
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
            setFeedbackPage(1)
            setFeedbackRevision(value => value + 1)
            setNotice('反馈已提交')
          }}
        />
      )}

      {loginOpen && (
        <LoginDialog
          onClose={() => setLoginOpen(false)}
          onLogin={async () => {
            setLoginOpen(false)
            const currentMe = await refreshMe()
            if (!currentMe.mustChangePassword && pendingView) {
              await enterAssistant(pendingView)
              setPendingView(null)
            }
            setNotice('已登录')
          }}
        />
      )}
      {passwordOpen && me.authenticated && !me.builtin && <PasswordDialog required={me.mustChangePassword} onClose={me.mustChangePassword ? undefined : () => setPasswordOpen(false)} onLogout={logout} onSaved={async () => {
        setPasswordOpen(false)
        await refreshMe()
        if (pendingView) { await enterAssistant(pendingView); setPendingView(null) }
        setNotice('密码已修改')
      }} />}
    </main>
  )
}

function HomeView({ statsRevision, feedback, feedbackPage, onFeedbackPage, isAdmin, onOpenAssistant, onReplySaved, setNotice }) {
  return (
    <>
      <AccordionSection eyebrow="Standard Interpretation" title="标准解读助手">
        <div className="assistantGrid standardAssistantGrid">
          <button className="assistantCard standard" type="button" onClick={() => onOpenAssistant('standard1')}>
            <span className="assistantIcon"><BookOpenCheck size={26} /></span>
            <span>
              <strong>标准解读（一厂）</strong>
              <small>提取标准关键要求并按管理员提示词生成结构化解读。</small>
            </span>
          </button>
          <button className="assistantCard standard" type="button" onClick={() => onOpenAssistant('standard2')}>
            <span className="assistantIcon"><BookOpenCheck size={26} /></span>
            <span>
              <strong>标准解读（二厂）</strong>
              <small>输入牌号并上传 Word 标准，按二厂提示词生成 Markdown 解读。</small>
            </span>
          </button>
          <button className="assistantCard standard" type="button" onClick={() => onOpenAssistant('standard3')}>
            <span className="assistantIcon"><BookOpenCheck size={26} /></span>
            <span>
              <strong>标准解读（三厂）</strong>
              <small>输入牌号并上传 Word 标准，按三厂提示词生成 Markdown 解读。</small>
            </span>
          </button>
        </div>
      </AccordionSection>

      <AccordionSection eyebrow="Document Conversion" title="PDF转word助手">
        <div className="assistantGrid singleAssistantGrid">
          <button className="assistantCard pdf" type="button" onClick={() => onOpenAssistant('pdf')}>
            <span className="assistantIcon"><FileOutput size={26} /></span>
            <span>
              <strong>PDF转word助手</strong>
              <small>支持文本 PDF 与扫描 PDF，逐页识别、整理排版并生成 Word。</small>
            </span>
          </button>
        </div>
      </AccordionSection>

      <AccordionSection eyebrow="Document Translation" title="翻译助手">
        <div className="assistantGrid singleAssistantGrid">
          <button className="assistantCard translate" type="button" onClick={() => onOpenAssistant('translate')}>
            <span className="assistantIcon"><Languages size={26} /></span>
            <span>
              <strong>翻译助手</strong>
              <small>支持文本对话与 Word 文档，并使用管理员词库完成翻译校订。</small>
            </span>
          </button>
        </div>
      </AccordionSection>

      <AccordionSection eyebrow="Knowledge Service" title="知识助手">
        <div className="assistantGrid knowledgeAssistantGrid">
          <button className="assistantCard qa" type="button" onClick={() => onOpenAssistant('qa')}>
            <span className="assistantIcon"><Bot size={26} /></span>
            <span>
              <strong>制造一厂知识问答AI助手</strong>
              <small>知识来源为云盘内相关文档。</small>
            </span>
          </button>
          <button
            className="assistantCard ragflow"
            type="button"
            onClick={() => onOpenAssistant('ragflow')}
          >
            <span className="assistantIcon"><Database size={26} /></span>
            <span>
              <strong>制造四厂知识问答助手</strong>
              <small>知识来源为制造四厂 RAGFlow 知识库。</small>
            </span>
          </button>
        </div>
      </AccordionSection>

      <UsageStatistics api={api} setNotice={setNotice} refreshKey={statsRevision} />

        <FeedbackBoard
          items={feedback.items}
          page={feedbackPage}
          pagination={feedback}
          onPage={onFeedbackPage}
          isAdmin={isAdmin}
          onReplySaved={onReplySaved}
          setNotice={setNotice}
        />
    </>
  )
}

function AccordionSection({ eyebrow, title, children }) {
  const [open, setOpen] = useState(false)
  return (
    <section className={`homeSection assistantSection ${open ? 'open' : ''}`}>
      <button className="accordionHeading" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span>
          <span className="eyebrow">{eyebrow}</span>
          <strong>{title}</strong>
        </span>
        <ChevronDown size={22} />
      </button>
      {open && <div className="accordionContent">{children}</div>}
    </section>
  )
}

function FeedbackBoard({ items, page, pagination, onPage, isAdmin, onReplySaved, setNotice }) {
  const [open, setOpen] = useState(false)
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
    <section className={`feedbackPanel ${open ? '' : 'collapsed'}`}>
      <button className="feedbackToggle" type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}><span><strong>问题意见</strong><small>{pagination.total} 条</small></span><ChevronDown className={open ? 'rotated' : ''} size={21} /></button>

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
      <Pagination page={page} totalPages={pagination.totalPages || 1} total={pagination.total} pageSize={3} onChange={onPage} />
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

function RagflowQaView({ setNotice }) {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: '你好，我是制造四厂知识问答助手。' },
  ])
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [loading, setLoading] = useState(false)
  const [stage, setStage] = useState('')
  const chatRailRef = useRef(null)
  const requestControllerRef = useRef(null)

  useEffect(() => {
    const rail = chatRailRef.current
    if (rail) rail.scrollTo({ top: rail.scrollHeight, behavior: 'smooth' })
  }, [messages, stage])

  useEffect(() => () => requestControllerRef.current?.abort(), [])

  function startNewConversation() {
    requestControllerRef.current?.abort()
    setMessages([{ role: 'assistant', content: '已开始新会话。请告诉我你想查询的内容。' }])
    setSessionId('')
    setLoading(false)
    setStage('')
  }

  function stopGenerating() {
    requestControllerRef.current?.abort()
    requestControllerRef.current = null
    setLoading(false)
    setStage('已停止生成')
  }

  async function sendMessage(event) {
    event.preventDefault()
    const text = input.trim()
    if (!text || loading) return

    const assistantIndex = messages.length + 1
    const requestMessages = [
      ...messages.slice(1)
        .filter((message) => !message.error && ['user', 'assistant'].includes(message.role) && message.content)
        .map((message) => ({ role: message.role, content: message.content })),
      { role: 'user', content: text },
    ]
    setMessages((current) => [
      ...current,
      { role: 'user', content: text },
      { role: 'assistant', content: '', references: [], streaming: true },
    ])
    setInput('')
    setLoading(true)
    setStage('正在连接 RAGFlow...')

    const controller = new AbortController()
    requestControllerRef.current = controller

    try {
      const response = await fetch('/api/ragflow/chat/stream', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text, sessionId, messages: requestMessages }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const errorText = await response.text()
        let errorData = {}
        try {
          errorData = errorText ? JSON.parse(errorText) : {}
        } catch {
          errorData = {}
        }
        throw new Error(errorData.error || '制造四厂知识问答助手调用失败')
      }

      await readQaStream(response, (eventData) => {
        if (eventData.type === 'stage') setStage(eventData.stage || '')
        if (eventData.type === 'session' && eventData.sessionId) setSessionId(eventData.sessionId)
        if (eventData.type === 'answer') {
          setStage('正在生成回答...')
          setMessages((current) => updateMessageAt(current, assistantIndex, {
            content: eventData.answer || '',
            streaming: true,
          }))
        }
        if (eventData.type === 'done') {
          if (eventData.sessionId) setSessionId(eventData.sessionId)
          setMessages((current) => updateMessageAt(current, assistantIndex, {
            content: eventData.answer || current[assistantIndex]?.content || '未返回内容',
            references: eventData.references || [],
            streaming: false,
          }))
          setStage('')
        }
        if (eventData.type === 'error') {
          throw new Error(eventData.error || '制造四厂知识问答助手流式调用失败')
        }
      })
    } catch (error) {
      if (error.name === 'AbortError') {
        setMessages((current) => updateMessageAt(current, assistantIndex, {
          content: current[assistantIndex]?.content || '回答已停止。',
          streaming: false,
          error: true,
        }))
      } else {
        setNotice(error.message)
        setMessages((current) => updateMessageAt(current, assistantIndex, {
          content: `调用失败：${error.message}`,
          references: [],
          streaming: false,
          error: true,
        }))
      }
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null
      setLoading(false)
      setStage('')
    }
  }

  return (
    <section className="workspace qaWorkspace ragflowWorkspace">
      <div className="qaToolbar">
        <div>
          <span className="eyebrow">RAGFlow Knowledge Service</span>
          <h2>制造四厂知识问答助手</h2>
          <p>知识来源为制造四厂 RAGFlow 知识库</p>
        </div>
        <div className="qaToolbarActions">
          <button className="ghost" type="button" onClick={startNewConversation} disabled={loading} title="开始新会话">
            <RefreshCw size={17} /> 新会话
          </button>
          <a className="ghost buttonLink" href="/api/assistants/ragflow/open?count=0" target="_blank" rel="noopener noreferrer">
            <ExternalLink size={17} /> 在 RAGFlow 中打开
          </a>
        </div>
      </div>

      <div className="chatRail" ref={chatRailRef}>
        {messages.map((message, index) => (
          <div className={`chatMessage ${message.role}`} key={`${message.role}-${index}`}>
            <span>{message.role === 'user' ? '用户' : '助手'}</span>
            <p className="chatText">
              {message.content || (message.streaming ? stage || '正在检索资料...' : '')}
              {message.streaming && <i className="streamCursor" />}
            </p>
            {message.role === 'assistant' && message.references?.length > 0 && (
              <div className="qaCites">
                <strong><Quote size={15} /> 参考资料</strong>
                <div className="qaCiteGrid">
                  {message.references.map((reference) => (
                    <article className="qaCiteCard ragflowReference" key={reference.id}>
                      <FileText size={17} />
                      <span>{reference.documentName}</span>
                      {reference.similarity != null && <small>相关度 {Math.round(reference.similarity * 100)}%</small>}
                      {reference.snippet && <em>{reference.snippet}</em>}
                    </article>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <form className="chatComposer" onSubmit={sendMessage}>
        <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="输入要咨询的问题" disabled={loading} />
        {loading ? (
          <button className="ghost" type="button" onClick={stopGenerating}>
            <Square size={17} /> 停止
          </button>
        ) : (
          <button className="primary" type="submit" disabled={!input.trim()}>
            <Send size={18} /> 发送
          </button>
        )}
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
  const [mode, setMode] = useState('chat')
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: '请输入需要翻译的文字。我会先直接翻译，再依据词库润色，最后检查误译、语法和时态。',
    },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const chatRailRef = useRef(null)

  useEffect(() => {
    const rail = chatRailRef.current
    if (!rail) return
    rail.scrollTo({ top: rail.scrollHeight, behavior: loading ? 'auto' : 'smooth' })
  }, [messages, loading])

  async function sendText(event) {
    event.preventDefault()
    const text = input.trim()
    if (!text || loading) return
    const assistantIndex = messages.length + 1
    setMessages((current) => [
      ...current,
      { role: 'user', content: text },
      { role: 'assistant', content: '', streaming: true, progress: 0, stage: '准备翻译' },
    ])
    setInput('')
    setLoading(true)
    try {
      const response = await fetch('/api/translate/chat/stream', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, direction }),
      })
      if (!response.ok) {
        const errorText = await response.text()
        let errorData = {}
        try { errorData = errorText ? JSON.parse(errorText) : {} } catch { errorData = {} }
        throw new Error(errorData.error || '翻译助手调用失败')
      }
      await readQaStream(response, (eventData) => {
        if (eventData.type === 'progress') {
          setMessages((current) => updateMessageAt(current, assistantIndex, {
            stage: eventData.stage,
            progress: eventData.progress,
            step: eventData.step,
          }))
        }
        if (eventData.type === 'answer') {
          setMessages((current) => updateMessageAt(current, assistantIndex, {
            content: eventData.answer || '',
            streaming: true,
          }))
        }
        if (eventData.type === 'done') {
          setMessages((current) => updateMessageAt(current, assistantIndex, {
            content: eventData.answer || '未返回内容',
            streaming: false,
            progress: 100,
            stage: '翻译完成',
            glossaryCount: eventData.glossaryCount || 0,
          }))
        }
        if (eventData.type === 'error') throw new Error(eventData.error || '翻译助手调用失败')
      })
    } catch (error) {
      setNotice(error.message)
      setMessages((current) => updateMessageAt(current, assistantIndex, {
        content: `翻译失败：${error.message}`,
        streaming: false,
        progress: 0,
        stage: '处理失败',
      }))
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="workspace translateWorkspace translationWorkbench">
      <div className="translationHeader">
        <div>
          <p className="eyebrow">Translation Workflow</p>
          <h2>翻译助手</h2>
        </div>
        <div className="translationControls">
          <div className="modeTabs" aria-label="翻译方式">
            <button type="button" className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}>
              <MessageSquare size={16} /> 对话翻译
            </button>
            <button type="button" className={mode === 'document' ? 'active' : ''} onClick={() => setMode('document')}>
              <FileText size={16} /> Word 文件
            </button>
          </div>
          <DirectionControl direction={direction} setDirection={setDirection} disabled={loading} />
        </div>
      </div>

      {mode === 'chat' ? (
        <div className="translationChat">
          <div className="chatRail translationRail" ref={chatRailRef}>
            {messages.map((message, index) => (
              <div className={`chatMessage ${message.role} translationMessage`} key={`${message.role}-${index}`}>
                <span>{message.role === 'user' ? '原文' : '翻译助手'}</span>
                {message.role === 'assistant' && message.stage && (
                  <div className="inlineTranslationProgress">
                    <div><Settings2 size={15} /><strong>{message.stage}</strong><b>{message.progress}%</b></div>
                    <div className="progressTrack"><i style={{ width: `${message.progress || 0}%` }} /></div>
                  </div>
                )}
                <pre className="translationMarkdown">
                  {message.content || (message.streaming ? '正在处理...' : '')}
                  {message.streaming && <i className="streamCursor" />}
                </pre>
                {message.glossaryCount !== undefined && (
                  <small className="glossaryUsage">本次校订使用 {message.glossaryCount} 条术语</small>
                )}
              </div>
            ))}
          </div>
          <form className="translationComposer" onSubmit={sendText}>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.ctrlKey && event.key === 'Enter') sendText(event)
              }}
              placeholder="输入需要翻译的文字"
              rows={4}
            />
            <button className="primary" type="submit" disabled={loading || !input.trim()}>
              <Send size={18} /> {loading ? '处理中...' : '发送翻译'}
            </button>
          </form>
        </div>
      ) : (
        <div className="translationDocumentMode">
          <div className="fileTypeNotice"><FileWarning size={19} /><span>仅支持 DOCX Word 文件，请勿上传 PDF、Excel 或其他格式。</span></div>
          <DocumentTaskView
            endpoint="/api/translate/document"
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            emptyLabel="选择待翻译 Word 文档"
            fileHint="系统将保留文本层级并输出 Markdown 格式的 Word 结果"
            actionLabel="开始翻译"
            workingLabel="正在翻译"
            icon={<Languages size={30} />}
            resultTitle="Markdown 翻译结果"
            setNotice={setNotice}
            extraFields={{ direction }}
            embedded
          />
        </div>
      )}
    </section>
  )
}

function DirectionControl({ direction, setDirection, disabled = false }) {
  return (
    <div className="segmented" aria-label="翻译方向">
      <button type="button" disabled={disabled} className={direction === 'en-zh' ? 'active' : ''} onClick={() => setDirection('en-zh')}>
        英译汉
      </button>
      <button type="button" disabled={disabled} className={direction === 'zh-en' ? 'active' : ''} onClick={() => setDirection('zh-en')}>
        汉译英
      </button>
    </div>
  )
}

function PdfToWordView({ setNotice }) {
  return (
    <DocumentTaskView
      title="PDF转word助手"
      description="上传 PDF 后，系统会逐页识别内容并恢复标题、段落、列表、表格与公式结构。"
      endpoint="/api/pdf-to-word"
      accept=".pdf,application/pdf"
      emptyLabel="选择待转换 PDF"
      fileHint="支持文本 PDF 与扫描 PDF，单文件最大 200 MB"
      actionLabel="开始转换"
      workingLabel="正在转换"
      icon={<ScanText size={30} />}
      resultTitle="转换内容预览"
      setNotice={setNotice}
    />
  )
}

function StandardView({ plant, setNotice }) {
  const [grade, setGrade] = useState('')
  const plantName = { 1: '一厂', 2: '二厂', 3: '三厂' }[plant] || '一厂'

  return (
    <DocumentTaskView
      title={`标准解读（${plantName}）`}
      description="上传 DOCX 标准文件，系统将依据管理员设置的提示词提取关键要求并生成结构化解读。"
      endpoint={`/api/standards/plant-${plant}`}
      accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      emptyLabel="选择待解读 Word 文档"
      fileHint="支持 DOCX；文档中的 Markdown 表格、公式文本和层级结构会尽量保留"
      actionLabel="开始解读"
      workingLabel="正在解读"
      icon={<BookOpenCheck size={30} />}
      resultTitle="标准解读预览"
      setNotice={setNotice}
      extraFields={{ grade }}
      formControl={(
        <label className="standardGradeField">
          <span>解读牌号</span>
          <input
            required
            maxLength={100}
            value={grade}
            onChange={(event) => setGrade(event.target.value)}
            placeholder="请输入所需解读的牌号"
          />
        </label>
      )}
    />
  )
}

function DocumentTaskView({
  title,
  description,
  endpoint,
  accept,
  emptyLabel,
  fileHint,
  actionLabel,
  workingLabel,
  icon,
  resultTitle,
  setNotice,
  extraFields = {},
  formControl = null,
  embedded = false,
}) {
  const [file, setFile] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [task, setTask] = useState(null)

  const processing = task && ['queued', 'processing'].includes(task.status)

  useEffect(() => {
    if (!task?.id || !processing) return undefined
    let active = true
    async function refreshTask() {
      try {
        const data = await api(`/api/document-tasks/${task.id}`)
        if (!active) return
        setTask(data.task)
        if (data.task.status === 'completed') setNotice('文档处理完成')
        if (data.task.status === 'failed') setNotice(data.task.error || '文档处理失败')
      } catch (error) {
        if (active) setNotice(error.message)
      }
    }
    refreshTask()
    const timer = window.setInterval(refreshTask, 1200)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [task?.id, processing, setNotice])

  async function submit(event) {
    event.preventDefault()
    if (!file) {
      setNotice(emptyLabel)
      return
    }
    const formData = new FormData()
    formData.append('file', file)
    Object.entries(extraFields).forEach(([key, value]) => formData.append(key, value))
    setSubmitting(true)
    setTask(null)
    try {
      const data = await api(endpoint, { method: 'POST', body: formData })
      setTask(data.task)
      setNotice('文件已上传，开始处理')
    } catch (error) {
      setNotice(error.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className={`${embedded ? 'embeddedTask' : 'workspace'} documentTaskWorkspace`}>
      {!embedded && (
        <div className="taskIntro">
          <div>
            <p className="eyebrow">Document Intelligence</p>
            <h2>{title}</h2>
          </div>
          <p>{description}</p>
        </div>
      )}

      <form className={`uploadPanel taskUploadPanel ${formControl ? 'withFormControl' : ''}`} onSubmit={submit}>
        <label className="uploadZone">
          {icon}
          <strong>{file ? file.name : emptyLabel}</strong>
          <span>{fileHint}</span>
          <input type="file" accept={accept} onChange={(event) => setFile(event.target.files?.[0] || null)} />
        </label>
        {formControl}
        <button className="primary" type="submit" disabled={submitting || processing}>
          <FileOutput size={18} /> {submitting || processing ? `${workingLabel}...` : actionLabel}
        </button>
      </form>

      {task && (
        <section className={`taskProgressPanel ${task.status}`} aria-live="polite">
          <div className="taskProgressHead">
            <span>
              {task.status === 'completed' ? <CheckCircle2 size={20} /> : task.status === 'failed' ? <AlertCircle size={20} /> : <Settings2 size={20} />}
              <strong>{task.stage}</strong>
            </span>
            <b>{task.progress}%</b>
          </div>
          <div className="progressTrack"><i style={{ width: `${task.progress}%` }} /></div>
          {task.error && <p className="formError">{task.error}</p>}
          {task.metadata?.thinkingVerification && (
            <p className="thinkingStatus">模型检查：{task.metadata.thinkingVerification}</p>
          )}
        </section>
      )}

      {task?.status === 'completed' && (
        <>
          <div className="translationMeta">
            <span><FileText size={16} /> {task.originalName}</span>
            <a className="downloadButton" href={task.downloadUrl}>
              <Download size={17} /> 保存为 Word
            </a>
          </div>
          <DocumentPane title={resultTitle} html={task.previewHtml} />
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

function AdminCollapsibleSection({ className, sectionId, eyebrow, title, summary, open, onToggle, children }) {
  const contentId = `${sectionId}-content`

  return (
    <section className={`${className} adminCollapsibleSection ${open ? 'open' : ''}`}>
      <button
        className="adminSectionToggle"
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={onToggle}
      >
        <span>
          <span className="eyebrow">{eyebrow}</span>
          <strong>{title}</strong>
        </span>
        <span className="adminSectionToggleCue">
          {summary && <span className="adminSectionCount">{summary}</span>}
          <span className="adminSectionToggleLabel">{open ? '收起' : '展开'}</span>
          <ChevronDown size={20} />
        </span>
      </button>
      <div className="adminSectionContent" id={contentId} hidden={!open}>
        {children}
      </div>
    </section>
  )
}

function AdminView({ me, isAdmin, onRequireLogin, setNotice }) {
  const permissions = me.permissions || []
  const canManageTerms = permissions.includes('glossary.manage')
  const canManagePrompts = permissions.some(item => item.startsWith('prompts.'))
  const canReadAudit = permissions.includes('audit.read')
  const [terms, setTerms] = useState([])
  const [prompts, setPrompts] = useState([])
  const [audit, setAudit] = useState([])
  const [termForm, setTermForm] = useState({ zhTerm: '', enTerm: '', note: '' })
  const [editingTermId, setEditingTermId] = useState(null)
  const [savingTerm, setSavingTerm] = useState(false)
  const [savingPrompt, setSavingPrompt] = useState('')
  const [expandedSections, setExpandedSections] = useState({ glossary: false, prompts: false, audit: false })

  useEffect(() => {
    if (isAdmin) {
      Promise.all([canManageTerms ? loadTerms() : Promise.resolve(), canManagePrompts ? loadPrompts() : Promise.resolve(), canReadAudit ? loadAudit() : Promise.resolve()]).catch((error) => setNotice(error.message))
    }
  }, [isAdmin, canManageTerms, canManagePrompts, canReadAudit, setNotice])

  async function loadTerms() {
    const data = await api('/api/glossary-terms')
    setTerms(data.items || [])
  }

  async function loadPrompts() {
    const data = await api('/api/admin/prompts')
    setPrompts(data.items || [])
  }

  async function loadAudit() {
    const data = await api('/api/admin/model-audit?limit=20')
    setAudit(data.items || [])
  }

  async function savePrompt(item) {
    setSavingPrompt(item.assistantId)
    try {
      await api(`/api/admin/prompts/${item.assistantId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: item.prompt }),
      })
      await loadPrompts()
      setNotice('提示词已保存')
    } catch (error) {
      setNotice(error.message)
    } finally {
      setSavingPrompt('')
    }
  }

  async function saveTerm(event) {
    event.preventDefault()
    setSavingTerm(true)
    try {
      await api(editingTermId ? `/api/glossary-terms/${editingTermId}` : '/api/glossary-terms', {
        method: editingTermId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(termForm),
      })
      setTermForm({ zhTerm: '', enTerm: '', note: '' })
      setEditingTermId(null)
      await loadTerms()
      setNotice(editingTermId ? '词库条目已更新' : '词库条目已新增')
    } catch (error) {
      setNotice(error.message)
    } finally {
      setSavingTerm(false)
    }
  }

  function editTerm(item) {
    setEditingTermId(item.id)
    setTermForm({ zhTerm: item.zhTerm, enTerm: item.enTerm, note: item.note || '' })
  }

  function cancelTermEdit() {
    setEditingTermId(null)
    setTermForm({ zhTerm: '', enTerm: '', note: '' })
  }

  function toggleSection(section) {
    setExpandedSections((current) => ({ ...current, [section]: !current[section] }))
  }

  async function deleteTerm(item) {
    if (!window.confirm(`确定删除术语“${item.zhTerm} / ${item.enTerm}”吗？`)) return
    try {
      await api(`/api/glossary-terms/${item.id}`, { method: 'DELETE' })
      if (editingTermId === item.id) cancelTermEdit()
      await loadTerms()
      setNotice('词库条目已删除')
    } catch (error) {
      setNotice(error.message)
    }
  }

  if (!isAdmin) {
    return (
      <section className="workspace adminLocked">
        <ShieldCheck size={42} />
        <h2>需要管理员身份</h2>
        <p>管理员登录后可逐条维护翻译词库、设置标准解读提示词并回复首页反馈。</p>
        <button className="primary" type="button" onClick={onRequireLogin}>
          <LogIn size={18} /> 管理员登录
        </button>
      </section>
    )
  }

  return (
    <section className="workspace adminWorkspace">
      {canManageTerms && <AdminCollapsibleSection
        className="glossaryManager"
        sectionId="admin-glossary"
        eyebrow="Terminology Assets"
        title="翻译术语词库"
        summary={`${terms.length} 条`}
        open={expandedSections.glossary}
        onToggle={() => toggleSection('glossary')}
      >
        <p className="glossaryHelp">每条术语会自动同步到后台 Markdown 词库，供翻译助手在直译后进行校订与润色。</p>
        <form className="termEditor" onSubmit={saveTerm}>
          <label>
            <span>中文术语</span>
            <input required maxLength={200} value={termForm.zhTerm} onChange={(event) => setTermForm((current) => ({ ...current, zhTerm: event.target.value }))} placeholder="例如：熔炼工序" />
          </label>
          <label>
            <span>英文术语</span>
            <input required maxLength={200} value={termForm.enTerm} onChange={(event) => setTermForm((current) => ({ ...current, enTerm: event.target.value }))} placeholder="例如：melting process" />
          </label>
          <label className="termNoteField">
            <span>说明（可选）</span>
            <input maxLength={500} value={termForm.note} onChange={(event) => setTermForm((current) => ({ ...current, note: event.target.value }))} placeholder="适用场景、缩写或使用要求" />
          </label>
          <div className="termFormActions">
            <button className="primary" type="submit" disabled={savingTerm}>
              {editingTermId ? <Save size={17} /> : <Plus size={17} />}
              {savingTerm ? '保存中...' : editingTermId ? '保存修改' : '新增术语'}
            </button>
            {editingTermId && (
              <button className="ghost" type="button" onClick={cancelTermEdit}>
                <X size={17} /> 取消
              </button>
            )}
          </div>
        </form>

        <div className="glossaryList">
          {terms.length === 0 && <p className="empty">暂无词库条目，请先新增一条术语。</p>}
          {terms.map((item) => (
            <article className={`glossaryItem termItem ${editingTermId === item.id ? 'editing' : ''}`} key={item.id}>
              <div className="termPair">
                <strong>{item.zhTerm}</strong>
                <span>{item.enTerm}</span>
              </div>
              <p>{item.note || '无补充说明'}</p>
              <time>{formatTime(item.updatedAt)}</time>
              <div className="termActions">
                <button className="iconButton" type="button" title="编辑术语" aria-label={`编辑 ${item.zhTerm}`} onClick={() => editTerm(item)}><Pencil size={17} /></button>
                <button className="iconButton danger" type="button" title="删除术语" aria-label={`删除 ${item.zhTerm}`} onClick={() => deleteTerm(item)}><Trash2 size={17} /></button>
              </div>
            </article>
          ))}
        </div>
      </AdminCollapsibleSection>}

      {canManagePrompts && <AdminCollapsibleSection
        className="promptSettings"
        sectionId="admin-prompts"
        eyebrow="Assistant Instructions"
        title="标准解读提示词"
        summary={`${prompts.length} 个`}
        open={expandedSections.prompts}
        onToggle={() => toggleSection('prompts')}
      >
        <div className="promptGrid">
          {prompts.map((item, index) => (
            <article className="promptEditor" key={item.assistantId}>
              <div>
                <strong>标准解读（{['一厂', '二厂', '三厂'][Number(item.assistantId.at(-1)) - 1]}）</strong>
                {index > 0 && <span>提示词可独立配置</span>}
              </div>
              <textarea
                rows={10}
                value={item.prompt}
                onChange={(event) => setPrompts((current) => current.map((prompt) =>
                  prompt.assistantId === item.assistantId ? { ...prompt, prompt: event.target.value } : prompt,
                ))}
              />
              <button className="primary small" type="button" disabled={savingPrompt === item.assistantId} onClick={() => savePrompt(item)}>
                <Save size={15} /> {savingPrompt === item.assistantId ? '保存中...' : '保存提示词'}
              </button>
            </article>
          ))}
        </div>
      </AdminCollapsibleSection>}

      {canReadAudit && <AdminCollapsibleSection
        className="modelAudit"
        sectionId="admin-model-audit"
        eyebrow="Thinking Audit"
        title="模型思考模式检查"
        summary={`${audit.length} 条记录`}
        open={expandedSections.audit}
        onToggle={() => toggleSection('audit')}
      >
        <div className="auditControls">
          <p className="auditHelp">每次模型调用均请求关闭思考。这里检查返回中是否仍包含 reasoning 字段或 think 标签，不记录文档正文和密钥。</p>
          <button className="ghost small" type="button" onClick={() => loadAudit().catch((error) => setNotice(error.message))}>
            <RefreshCw size={15} /> 刷新
          </button>
        </div>
        <div className="auditList">
          {audit.length === 0 && <p className="empty">暂无模型调用记录。</p>}
          {audit.map((item, index) => {
            const passed = !item.responseHasReasoning && !item.contentContainsThinkTag
            return (
              <article className={`auditItem ${passed ? 'passed' : 'warning'}`} key={`${item.timestamp}-${index}`}>
                {passed ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
                <div>
                  <strong>{item.purpose}</strong>
                  <span>{formatTime(item.timestamp)} · {item.model} · {item.status}</span>
                </div>
                <b>{passed ? '未发现思考内容' : '发现思考标记'}</b>
              </article>
            )
          })}
        </div>
      </AdminCollapsibleSection>}
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
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(event) {
    event.preventDefault()
    setError('')
    setSaving(true)
    try {
      await api('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      await onLogin()
    } catch (loginError) {
      setError(loginError.message)
    } finally { setSaving(false) }
  }

  return (
    <Dialog title="登录 AI助手服务台" onClose={onClose}>
      <form className="dialogForm" onSubmit={submit}>
        <input required value={username} onChange={(event) => setUsername(event.target.value)} placeholder="工号 / OA 账号" autoComplete="username" autoFocus />
        <input required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" type="password" autoComplete="current-password" />
        {error && <p className="formError">{error}</p>}
        <button className="primary" type="submit" disabled={saving}>
          <LogIn size={18} /> {saving ? '登录中...' : '登录'}
        </button>
      </form>
    </Dialog>
  )
}

function PasswordDialog({ required, onClose, onSaved, onLogout }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  async function submit(event) {
    event.preventDefault()
    if (password !== confirmation) { setError('两次输入的新密码不一致'); return }
    setSaving(true); setError('')
    try {
      await api('/api/account/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword, password }) })
      await onSaved()
    } catch (submitError) { setError(submitError.message) } finally { setSaving(false) }
  }
  return <Dialog title={required ? '首次登录 · 修改密码' : '修改密码'} onClose={onClose}>
    {required && <p className="passwordRequirement">请修改初始密码后继续使用。</p>}
    <form className="dialogForm" onSubmit={submit}>
      <input required type="password" autoComplete="current-password" placeholder="当前密码" aria-label="当前密码" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} />
      <input required minLength={6} maxLength={128} type="password" autoComplete="new-password" placeholder="新密码（至少 6 位）" aria-label="新密码" value={password} onChange={event => setPassword(event.target.value)} />
      <input required type="password" autoComplete="new-password" placeholder="再次输入新密码" aria-label="再次输入新密码" value={confirmation} onChange={event => setConfirmation(event.target.value)} />
      {error && <p className="formError">{error}</p>}
      <button className="primary" type="submit" disabled={saving}><KeyRound size={17} />{saving ? '保存中...' : '保存新密码'}</button>
      {required && <button className="ghost" type="button" onClick={() => onLogout().catch(logoutError => setError(logoutError.message))}><LogOut size={16} />退出登录</button>}
    </form>
  </Dialog>
}

function Dialog({ title, children, onClose }) {
  return (
    <div className="dialogBackdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialogHead">
          <h2>{title}</h2>
          {onClose && <button type="button" title="关闭" aria-label="关闭" onClick={onClose}><X size={18} /></button>}
        </div>
        {children}
      </section>
    </div>
  )
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'include', ...options })
  const text = await response.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { throw new Error('服务返回内容异常，请检查后端是否启动或重启服务') }
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') window.dispatchEvent(new Event('platform-login-required'))
    if (data.code === 'PASSWORD_CHANGE_REQUIRED') window.dispatchEvent(new Event('platform-password-required'))
    throw new Error(data.error || data.message || '请求失败')
  }
  return data
}

function createUsageRequestId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('')
}

function formatTime(value) {
  if (!value) return ''
  return new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default App

import {useEffect, useRef, useState} from 'react'
import {ExternalLink, FileText, Plus, RefreshCw, Trash2, Upload} from 'lucide-react'
import {Pagination} from './PlatformViews.jsx'
import './VersionNotes.css'

const initial = {items: [], total: 0, page: 1, totalPages: 1, latestId: null}
const fileLimit = 200 * 1024 * 1024
const time = value => new Date(value).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'})
const size = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`

export default function VersionNotes({api, Dialog, isSuperAdmin, setNotice}) {
  const [data, setData] = useState(initial)
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [deleting, setDeleting] = useState(null)
  useEffect(() => {if (!isSuperAdmin) {setPublishing(false); setDeleting(null)}}, [isSuperAdmin])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    api(`/api/version-notes?page=${page}`, {signal: controller.signal}).then(value => {
      if (controller.signal.aborted) return
      setData(value)
      setPage(value.page)
    }).catch(value => {if (!controller.signal.aborted) setError(value.message)})
      .finally(() => {if (!controller.signal.aborted) setLoading(false)})
    return () => controller.abort()
  }, [api, page, revision])
  return <section className="versionSection" aria-labelledby="version-notes-title">
    <div className="versionHeading"><div><h2 id="version-notes-title">版本说明</h2><span>{data.total} 条</span></div>
      {isSuperAdmin && <button className="primary small" type="button" onClick={() => setPublishing(true)}><Plus size={17}/>发布版本</button>}
    </div>
    <div className="versionList" aria-busy={loading}>
      {error ? <div className="versionEmpty"><p role="alert">{error}</p><button className="ghost small" type="button" onClick={() => setRevision(value => value + 1)}><RefreshCw size={16}/>重试</button></div>
        : !data.items.length ? <div className="versionEmpty" role="status"><FileText size={30}/><p>{loading ? '正在读取版本说明...' : '暂无版本说明'}</p></div>
          : data.items.map(item => <article className="versionEntry" key={item.id}>
            <div className="versionIdentity"><strong>{item.version}</strong>{item.id === data.latestId && <span className="latestBadge">最新</span>}</div>
            <div className="versionDocument"><a className="manualLink" href={item.previewUrl} target="_blank" rel="noopener noreferrer" title={`查看 ${item.originalName}`}>
              <span className="pdfMark"><FileText size={22}/></span><span className="manualName">{item.originalName}</span><ExternalLink size={15}/>
            </a><div className="versionMeta"><time dateTime={item.createdAt}>{time(item.createdAt)}</time><span>{size(item.fileSize)}</span></div></div>
            {isSuperAdmin && <button className="deleteVersion" type="button" title={`删除 ${item.version}`} aria-label={`删除 ${item.version}`} onClick={() => setDeleting(item)}><Trash2 size={17}/></button>}
          </article>)}
    </div>
    {!error && data.total > 0 && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} pageSize={3} onChange={setPage}/>}
    {isSuperAdmin && publishing && <PublishVersion api={api} Dialog={Dialog} onClose={() => setPublishing(false)} onSaved={() => {
      setPublishing(false); setPage(1); setRevision(value => value + 1); setNotice('版本说明已发布')
    }}/>}
    {isSuperAdmin && deleting && <DeleteVersion api={api} Dialog={Dialog} item={deleting} onClose={() => setDeleting(null)} onSaved={warning => {
      setDeleting(null); setRevision(value => value + 1); setNotice(warning || '版本说明已删除')
    }}/>}
  </section>
}

function VersionDialog({Dialog, title, onClose, children}) {
  const scope = useRef(null)
  const close = useRef(onClose)
  useEffect(() => {close.current = onClose}, [onClose])
  useEffect(() => {
    const previous = document.activeElement
    const dialog = scope.current.closest('[role="dialog"]')
    const controls = () => [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href]')].filter(node => node.getClientRects().length)
    const first = scope.current.querySelector('input') || controls()[0]
    first?.focus()
    const onKey = event => {
      if (event.key === 'Escape' && close.current) {event.preventDefault(); close.current()}
      if (event.key !== 'Tab') return
      const items = controls(), first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus()}
      else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus()}
    }
    dialog.addEventListener('keydown', onKey)
    return () => {dialog.removeEventListener('keydown', onKey); if (previous?.isConnected) previous.focus()}
  }, [])
  return <Dialog title={title} onClose={onClose}><div className="versionDialogBody" ref={scope}>{children}</div></Dialog>
}

function PublishVersion({api, Dialog, onClose, onSaved}) {
  const [version, setVersion] = useState('')
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function publish(event) {
    event.preventDefault()
    if (busy) return
    if (!file || !/\.pdf$/i.test(file.name)) {setError('请选择 PDF 格式的使用说明'); return}
    if (file.size > fileLimit) {setError('使用说明 PDF 不能超过 200 MB'); return}
    const body = new FormData(); body.append('version', version.trim()); body.append('file', file)
    setBusy(true); setError('')
    try {await api('/api/admin/version-notes', {method: 'POST', body}); onSaved()}
    catch (value) {setError(value.message)}
    finally {setBusy(false)}
  }
  return <VersionDialog Dialog={Dialog} title="发布版本说明" onClose={busy ? undefined : onClose}>
    <form className="dialogForm" onSubmit={publish} aria-busy={busy}>
      <label className="versionField">版本号<input type="text" name="version" value={version} onChange={event => setVersion(event.target.value)} maxLength={40} placeholder="例如 v1.5.0" required disabled={busy}/></label>
      <label className="versionField">使用说明 PDF<span className="manualPicker"><Upload size={20}/><span>{file ? file.name : '选择 PDF 文件'}</span><input type="file" name="file" accept=".pdf,application/pdf" required disabled={busy} onChange={event => {setFile(event.target.files?.[0] || null); setError('')}}/></span><small>PDF · 最大 200 MB</small></label>
      {error && <p className="versionFormError" role="alert">{error}</p>}
      <div className="versionActions"><button className="ghost" type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" type="submit" disabled={busy || !version.trim() || !file}>{busy ? <RefreshCw size={17} className="spinning"/> : <Upload size={17}/>} {busy ? '正在发布...' : '发布'}</button></div>
    </form>
  </VersionDialog>
}

function DeleteVersion({api, Dialog, item, onClose, onSaved}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function remove() {
    if (busy) return
    setBusy(true); setError('')
    try {const result = await api(`/api/admin/version-notes/${item.id}`, {method: 'DELETE'}); onSaved(result.warning)}
    catch (value) {setError(value.message)}
    finally {setBusy(false)}
  }
  return <VersionDialog Dialog={Dialog} title="删除版本说明" onClose={busy ? undefined : onClose}>
    <p>确认删除这条版本说明和使用说明 PDF？</p><div className="deleteVersionTarget"><strong>{item.version}</strong><span>{item.originalName}</span></div>
    {error && <p className="versionFormError" role="alert">{error}</p>}
    <div className="versionActions"><button className="ghost" type="button" disabled={busy} onClick={onClose}>取消</button><button className="versionDanger" type="button" disabled={busy} onClick={remove}><Trash2 size={17}/>{busy ? '正在删除...' : '确认删除'}</button></div>
  </VersionDialog>
}

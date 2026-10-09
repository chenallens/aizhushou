import {useEffect,useId,useRef,useState} from 'react'
import {AlertTriangle,Archive,BookOpen,ListPlus,Pencil,Plus,RefreshCw,Save,Search,Trash2,X} from 'lucide-react'
import {Pagination} from './PlatformViews.jsx'
import {glossaryOptions} from './glossary-options.js'
import './GlossaryManager.css'

const emptyRow=()=>({zhTerm:'',enTerm:'',note:''})
function GlossaryDialog({title,onClose,children,busy=false,wide=false}) {
  const ref=useRef(null),titleId=useId()
  const closeRef=useRef(onClose),busyRef=useRef(busy)
  closeRef.current=onClose;busyRef.current=busy
  useEffect(()=>{
    const previous=document.activeElement,overflow=document.body.style.overflow
    document.body.style.overflow='hidden'
    const first=ref.current?.querySelector('input')||ref.current?.querySelector('button')
    first?.focus()
    const keys=event=>{
      if(event.key==='Escape'&&!busyRef.current)closeRef.current()
      if(event.key!=='Tab')return
      const items=Array.from(ref.current.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)'))
      if(!items.length)return
      const first=items[0],last=items.at(-1)
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
    }
    document.addEventListener('keydown',keys)
    return ()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',keys);if(document.contains(previous))previous.focus()}
  },[])
  return <div className="glossaryDialogBackdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose()}}><section ref={ref} className={`glossaryDialog ${wide?'wide':''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}><div className="dialogHead"><h2 id={titleId}>{title}</h2><button className="iconButton" type="button" aria-label="关闭" title="关闭" disabled={busy} onClick={onClose}><X size={18}/></button></div>{children}</section></div>
}

export default function GlossaryManager({api,setNotice,onCountChange}) {
  const [libraryId,setLibraryId]=useState('general'),[libraries,setLibraries]=useState(glossaryOptions)
  const [data,setData]=useState({items:[],total:0,page:1,totalPages:1,pageSize:20})
  const [search,setSearch]=useState(''),[query,setQuery]=useState(''),[page,setPage]=useState(1),[revision,setRevision]=useState(0)
  const [selection,setSelection]=useState(new Map()),[editor,setEditor]=useState(null),[duplicate,setDuplicate]=useState(null),[deletion,setDeletion]=useState(null)
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[ready,setReady]=useState(false)
  const selectAllRef=useRef(null)
  useEffect(()=>{if(selectAllRef.current)selectAllRef.current.indeterminate=data.items.some(item=>selection.has(item.id))&&!data.items.every(item=>selection.has(item.id))},[data.items,selection])
  useEffect(()=>{const timer=setTimeout(()=>setQuery(search),250);return()=>clearTimeout(timer)},[search])
  useEffect(()=>{
    const controller=new AbortController();setLoading(true)
    Promise.all([api('/api/glossary-libraries',{signal:controller.signal}),api(`/api/glossary-terms?${new URLSearchParams({libraryId,q:query,page:String(page)})}`,{signal:controller.signal})]).then(([catalog,rows])=>{
      if(controller.signal.aborted)return
      setLibraries(catalog.items);onCountChange(catalog.items.reduce((sum,item)=>sum+(item.count||0),0));setData(rows);setReady(true)
    }).catch(failure=>{if(!controller.signal.aborted)setNotice(failure.message)}).finally(()=>{if(!controller.signal.aborted)setLoading(false)})
    return()=>controller.abort()
  },[api,onCountChange,setNotice,libraryId,query,page,revision])
  const libraryName=libraries.find(item=>item.id===libraryId)?.name||'通用术语库'
  function choose(id){setLibraryId(id);setSearch('');setQuery('');setPage(1);setData({items:[],total:0,page:1,totalPages:1,pageSize:20});setSelection(new Map());setError('')}
  function select(item,checked){if(checked&&selection.size>=100&&!selection.has(item.id)){setNotice('每次最多选择 100 条术语');return}setSelection(previous=>{const next=new Map(previous);if(checked)next.set(item.id,item);else next.delete(item.id);return next})}
  function openEditor(kind,items){setEditor({kind,rows:items.map(item=>({...item}))});setDuplicate(null);setError('')}
  function changeRow(index,field,value){setEditor(current=>({...current,rows:current.rows.map((row,position)=>position===index?{...row,[field]:value}:row)}))}
  function closeEditor(){if(!busy){setEditor(null);setDuplicate(null);setError('')}}
  async function submit(allowDuplicates=false){
    const rows=editor.rows.filter(item=>item.zhTerm.trim()||item.enTerm.trim()||item.note.trim()).map(item=>({...item,zhTerm:item.zhTerm.trim(),enTerm:item.enTerm.trim(),note:item.note.trim()}))
    if(!rows.length||rows.some(item=>!item.zhTerm||!item.enTerm)){setError('请填写每条术语的中文和英文。');return}
    if(rows.length>100){setError('每次最多保存 100 条术语。');return}
    const isSingle=editor.kind==='single',updating=rows[0].id!==undefined
    const body=isSingle?{...rows[0],libraryId,allowDuplicates,expectedUpdatedAt:rows[0].updatedAt}:{action:updating?'update':'create',libraryId,allowDuplicates,items:rows.map(item=>({...item,expectedUpdatedAt:item.updatedAt}))}
    const endpoint=isSingle?(updating?`/api/glossary-terms/${rows[0].id}`:'/api/glossary-terms'):'/api/glossary-terms/batch'
    setBusy(true);setError('')
    try {
      const result=await api(endpoint,{method:isSingle&&updating?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      if(result.requiresConfirmation){setDuplicate(result);return}
      setDuplicate(null);setEditor(null);setSelection(new Map());setPage(1);setRevision(value=>value+1);setNotice(result.warning||'术语已保存')
    }catch(failure){setError(failure.message)}finally{setBusy(false)}
  }
  function pasteRows(event,start){
    if(editor.kind!=='create')return
    const text=event.clipboardData.getData('text');if(!text.includes('\t'))return
    event.preventDefault();const lines=text.trimEnd().split(/\r?\n/)
    if(start+lines.length>100){setError('每次最多保存 100 条术语。');return}
    setEditor(current=>{const rows=[...current.rows];lines.forEach((line,index)=>{const cells=line.split('\t');rows[start+index]={zhTerm:cells[0]||'',enTerm:cells[1]||'',note:cells[2]||''}});return {...current,rows}})
  }
  async function remove(){
    setBusy(true);setError('')
    try {await api('/api/glossary-terms/batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'delete',libraryId,ids:deletion.map(item=>item.id)})});setDeletion(null);setSelection(new Map());setRevision(value=>value+1);setNotice('选中术语已删除')}
    catch(failure){setError(failure.message)}finally{setBusy(false)}
  }
  const allSelected=data.items.length>0&&data.items.every(item=>selection.has(item.id))
  return <div className="categorizedGlossary" aria-busy={loading}>
    <div className="glossaryLibraryTabs" role="tablist" aria-label="术语库分类">{libraries.map(item=><button type="button" role="tab" aria-selected={libraryId===item.id} className={libraryId===item.id?'active':''} key={item.id} onClick={()=>choose(item.id)}>{item.name}<small>{item.count||0}</small></button>)}</div>
    {libraryId==='general'&&<p className="glossaryMigrationNote"><Archive size={15}/>旧版本已录入的术语保留为通用术语。</p>}
    <div className="glossaryTools"><label className="glossarySearch"><Search size={17}/><input placeholder="搜索中文、英文或备注" aria-label="搜索中文、英文或备注" value={search} onChange={event=>{setSearch(event.target.value);setPage(1);setSelection(new Map())}}/></label><div className="glossaryCommands"><button type="button" className="iconButton" title="刷新术语" aria-label="刷新术语" disabled={loading} onClick={()=>{setSelection(new Map());setRevision(value=>value+1)}}><RefreshCw size={17}/></button><button className="ghost small" type="button" disabled={!ready} onClick={()=>openEditor('create',Array.from({length:4},emptyRow))}><ListPlus size={17}/>批量新增</button><button className="primary small" type="button" disabled={!ready} onClick={()=>openEditor('single',[emptyRow()])}><Plus size={17}/>新增术语</button></div></div>
    {selection.size>0&&<div className="glossarySelection"><span>已选择 {selection.size} 条</span><button type="button" className="ghost small" onClick={()=>openEditor('update',[...selection.values()])}><Pencil size={15}/>批量修改</button><button type="button" className="ghost small glossaryDanger" onClick={()=>{setError('');setDeletion([...selection.values()])}}><Trash2 size={15}/>删除选中</button><button type="button" className="iconButton" title="取消选择" aria-label="取消选择" onClick={()=>setSelection(new Map())}><X size={17}/></button></div>}
    <div className="platformTableViewport"><table className="platformTable glossaryTable"><thead><tr><th><input ref={selectAllRef} type="checkbox" aria-label="选择当前页全部术语" checked={allSelected} onChange={event=>{const checked=event.target.checked;setSelection(previous=>{const next=new Map(previous);for(const item of data.items){if(checked&&next.size<100)next.set(item.id,item);else if(!checked)next.delete(item.id)}return next})}}/></th><th>中文术语</th><th>英文术语</th><th>备注</th><th>更新日期</th><th>操作</th></tr></thead><tbody>{data.items.map(item=><tr key={item.id} className={selection.has(item.id)?'selected':''}><td><input type="checkbox" aria-label={`选择${item.zhTerm}`} checked={selection.has(item.id)} onChange={event=>select(item,event.target.checked)}/></td><td><span>{item.zhTerm}</span>{item.duplicate&&<small className="glossaryDuplicateBadge" title="当前库存在中文或英文重复">重复</small>}</td><td>{item.enTerm}</td><td>{item.note||'—'}</td><td className="glossaryDate">{new Date(item.updatedAt).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})}</td><td><div className="glossaryRowActions"><button type="button" className="iconButton" title={`编辑${item.zhTerm}`} aria-label={`编辑${item.zhTerm}`} onClick={()=>openEditor('single',[item])}><Pencil size={17}/></button><button type="button" className="iconButton glossaryDanger" title={`删除${item.zhTerm}`} aria-label={`删除${item.zhTerm}`} onClick={()=>{setError('');setDeletion([item])}}><Trash2 size={17}/></button></div></td></tr>)}</tbody></table></div>
    {!data.total&&<p className="empty">{loading?'正在读取术语...':search?'没有匹配的术语':'当前术语库暂无条目'}</p>}
    <Pagination page={data.page} totalPages={data.totalPages} total={data.total} pageSize={data.pageSize} onChange={setPage}/>
    {editor&&!duplicate&&<GlossaryDialog title={editor.kind==='single'?(editor.rows[0].id?'编辑术语':'新增术语'):editor.kind==='create'?'批量新增':'批量修改'} onClose={closeEditor} busy={busy} wide={editor.kind!=='single'}><p className="glossaryDialogLibrary"><BookOpen size={16}/>{libraryName}</p><form onSubmit={event=>{event.preventDefault();submit()}}>
      {editor.kind==='single'?['zhTerm','enTerm','note'].map((field,index)=><label className="glossaryFormField" key={field}><span>{['中文术语','英文术语','备注（可选）'][index]}</span><input required={field!=='note'} aria-label={['中文术语','英文术语','备注'][index]} maxLength={field==='note'?500:200} value={editor.rows[0][field]} onChange={event=>changeRow(0,field,event.target.value)}/></label>):<><div className="glossaryBatchViewport"><table className="glossaryBatchTable"><thead><tr><th>#</th><th>中文术语</th><th>英文术语</th><th>备注</th><th/></tr></thead><tbody>{editor.rows.map((item,index)=><tr key={item.id||index}><td>{index+1}</td>{['zhTerm','enTerm','note'].map((field,position)=><td key={field}><input aria-label={`第 ${index+1} 行${['中文术语','英文术语','备注'][position]}`} maxLength={field==='note'?500:200} value={item[field]} onChange={event=>changeRow(index,field,event.target.value)} onPaste={event=>pasteRows(event,index)}/></td>)}<td><button type="button" className="iconButton" title="移除此行" aria-label={`移除第 ${index+1} 行`} disabled={busy||editor.rows.length===1} onClick={()=>setEditor(current=>({...current,rows:current.rows.filter((_,position)=>position!==index)}))}><X size={16}/></button></td></tr>)}</tbody></table></div>{editor.kind==='create'&&<button className="ghost small glossaryAddRow" type="button" disabled={editor.rows.length>=100||busy} onClick={()=>setEditor(current=>({...current,rows:[...current.rows,emptyRow()]}))}><Plus size={16}/>添加行</button>}</>}
      {error&&<p className="formError">{error}</p>}<div className="glossaryDialogActions"><button type="button" className="ghost" disabled={busy} onClick={closeEditor}>取消</button><button type="submit" className="primary" disabled={busy}><Save size={17}/>{busy?'保存中...':editor.kind==='single'?'保存':'保存全部'}</button></div></form></GlossaryDialog>}
    {duplicate&&<GlossaryDialog title="存在重复术语" onClose={()=>{if(!busy)setDuplicate(null)}} busy={busy} wide><div className="glossaryWarning"><AlertTriangle size={22}/><span>当前术语库中存在中文或英文重复的条目。</span></div><p className="glossaryDialogLibrary"><BookOpen size={16}/>{libraryName}</p><div className="glossaryConflictViewport"><table className="glossaryConflictTable"><thead><tr><th>待保存的术语</th><th>已存在的中文</th><th>已存在的英文</th><th>重复项</th></tr></thead><tbody>{duplicate.conflicts.map((item,index)=><tr key={index}><td>{item.incoming.zhTerm}<small>{item.incoming.enTerm}</small>{editor.rows.length>1&&<small>第 {item.row} 行</small>}</td><td>{item.existing.zhTerm}{item.inBatch&&<small>本批次第 {item.existing.batchRow} 行</small>}</td><td>{item.existing.enTerm}</td><td><span className="glossaryDuplicateBadge">{item.zhDuplicate&&item.enDuplicate?'中文、英文重复':item.zhDuplicate?'中文重复':'英文重复'}</span></td></tr>)}</tbody></table></div>{error&&<p className="formError">{error}</p>}<div className="glossaryDialogActions"><button type="button" className="ghost" disabled={busy} onClick={()=>setDuplicate(null)}>返回修改</button><button type="button" className="primary" disabled={busy} onClick={()=>submit(true)}><Save size={17}/>{busy?'保存中...':editor.rows.some(item=>item.id)?'仍然保存':'仍然录入'}</button></div></GlossaryDialog>}
    {deletion&&<GlossaryDialog title={deletion.length>1?'删除选中术语':'删除术语'} onClose={()=>{if(!busy)setDeletion(null)}} busy={busy}><ul className="glossaryDeletePairs">{deletion.map(item=><li key={item.id}>{item.zhTerm}<small>{item.enTerm}</small></li>)}</ul>{error&&<p className="formError">{error}</p>}<div className="glossaryDialogActions"><button type="button" className="ghost" disabled={busy} onClick={()=>setDeletion(null)}>取消</button><button type="button" className="primary glossaryDeleteConfirm" disabled={busy} onClick={remove}><Trash2 size={17}/>{busy?'删除中...':'确认删除'}</button></div></GlossaryDialog>}
  </div>
}

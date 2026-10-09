import { useEffect, useRef, useState } from 'react'
import { Building2, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, FolderTree, History, KeyRound, Plus, RefreshCw, Search, ShieldCheck, Table2, Trash2, UserPlus, Users, X } from 'lucide-react'
import './PlatformViews.css'

const metrics = [
  {key:'qaNativeUses',label:'制造一厂问答使用',short:'一厂问答',color:'#1268d6'},
  {key:'ragflowUses',label:'制造四厂问答使用',short:'四厂问答',color:'#159e99'},
  {key:'translationUses',label:'翻译助手使用',short:'翻译',color:'#ba871c'},
  {key:'pdfUses',label:'PDF 转 Word 使用',short:'PDF 转 Word',color:'#6388ae'},
  {key:'standardUses',label:'标准解读使用',short:'标准解读',color:'#199963'},
]

const roleNames = {
  super_admin:'超级管理员',glossary_admin:'翻译术语库管理员',
  prompt_plant_1:'一厂提示词管理员',prompt_plant_2:'二厂提示词管理员',prompt_plant_3:'三厂提示词管理员',
}
const permissionNames={ 'users.manage':'用户管理','roles.manage':'角色分配','organization.sync':'人员组织同步','glossary.manage':'翻译术语库','prompts.1':'一厂提示词','prompts.2':'二厂提示词','prompts.3':'三厂提示词','feedback.reply':'反馈回复','audit.read':'模型审计' }
const number=value=>Number(value||0).toLocaleString('zh-CN')
const time=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—'
const currentKey=period=>new Date(Date.now()+8*3600_000).toISOString().slice(0,period==='year'?4:7)

function useSearch(value) {
  const [search,setSearch]=useState(value)
  useEffect(()=>{const timer=setTimeout(()=>setSearch(value),250);return ()=>clearTimeout(timer)},[value])
  return search
}

export function Pagination({ page, totalPages, total, onChange, pageSize }) {
  const pages=[...new Set([1,page-1,page,page+1,totalPages])].filter(item=>item>=1&&item<=totalPages).sort((a,b)=>a-b)
  return <div className="platformPager">
    <span>共 {number(total)} 条{pageSize ? ` · 每页 ${pageSize} 条` : ''}</span>
    <button className="iconButton" type="button" title="上一页" aria-label="上一页" disabled={page<=1} onClick={()=>onChange(page-1)}><ChevronLeft size={17}/></button>
    {pages.map((item,index)=><span className="pageNumberGroup" key={item}>{index>0&&item-pages[index-1]>1&&<span>…</span>}<button className={item===page?'selected':''} type="button" aria-current={item===page?'page':undefined} onClick={()=>onChange(item)}>{item}</button></span>)}
    <button className="iconButton" type="button" title="下一页" aria-label="下一页" disabled={page>=totalPages} onClick={()=>onChange(page+1)}><ChevronRight size={17}/></button>
  </div>
}

export function UsageStatistics({api,setNotice,refreshKey}) {
  const [period,setPeriod]=useState('month')
  const [key,setKey]=useState(currentKey('month'))
  const [departmentId,setDepartmentId]=useState('')
  const [companyId,setCompanyId]=useState('')
  const [metric,setMetric]=useState('all')
  const [data,setData]=useState(null)
  const [loading,setLoading]=useState(false)
  const [details,setDetails]=useState(false)
  const [page,setPage]=useState(1)
  useEffect(()=>{
    const controller=new AbortController()
    setLoading(true)
    api(`/api/stats?${new URLSearchParams({period,key,companyId,departmentId})}`,{signal:controller.signal})
      .then(result=>{setData(result);setPage(1)})
      .catch(error=>{if (!controller.signal.aborted) setNotice(error.message)})
      .finally(()=>{if (!controller.signal.aborted) setLoading(false)})
    return ()=>controller.abort()
  },[api,setNotice,period,key,companyId,departmentId,refreshKey])
  const departments=data?.departments||[]
  const heightOf=item=>metric==='all'?item.total:item[metric]
  const maximum=Math.max(1,...departments.map(heightOf))
  const scale=Math.ceil(maximum/4/Math.max(1,10**Math.floor(Math.log10(maximum)-1)))*4*Math.max(1,10**Math.floor(Math.log10(maximum)-1))
  const shownMetrics=metric==='all'?metrics:metrics.filter(item=>item.key===metric)
  const pageSize=10
  return <section className="homeSection usageSection" aria-busy={loading}>
    <div className="usageHeading"><div><p className="eyebrow">Usage Metrics</p><h2>统计指标</h2></div>
      <div className="periodControls"><span className="todayVisits">今日活跃访问 {number(data?.active.day)} 次</span><div className="periodTabs" role="tablist" aria-label="统计类型">
        {['month','year'].map(item=><button role="tab" aria-selected={period===item} className={period===item?'selected':''} type="button" key={item} onClick={()=>{setPeriod(item);setKey(currentKey(item));setCompanyId('');setDepartmentId('')}}>{item==='month'?'月度统计':'年度统计'}</button>)}
      </div><select aria-label="统计周期" value={key} onChange={event=>{setKey(event.target.value);setCompanyId('');setDepartmentId('')}}>{(data?.availablePeriods?.includes(key)?data.availablePeriods:[key]).map(value=><option value={value} key={value}>{period==='year'?`${value} 年`:`${value.slice(0,4)} 年 ${Number(value.slice(5))} 月`}</option>)}</select></div>
    </div>
    <div className="periodMetrics">{metrics.map(item=><article className="periodMetric" key={item.key} style={{borderTopColor:item.color}}><span>{item.label}</span><strong>{number(data?.[item.key])}<small>次</small></strong></article>)}</div>
    <div className="departmentStatistics">
      <div className="departmentChartHeading"><h3>{companyId?'部门使用统计':'公司使用统计'}</h3><div className="statsFilters"><label>公司<select aria-label="统计公司" value={companyId} onChange={event=>{setCompanyId(event.target.value);setDepartmentId('')}}><option value="">全部公司</option>{data?.companyOptions.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>部门<select aria-label="统计部门" value={departmentId} onChange={event=>setDepartmentId(event.target.value)}><option value="">全部部门</option>{data?.departmentOptions.map(item=><option key={item.id} value={item.id}>{item.path||item.name}</option>)}</select></label><label>指标<select aria-label="统计指标" value={metric} onChange={event=>setMetric(event.target.value)}><option value="all">使用合计</option>{metrics.map(item=><option key={item.key} value={item.key}>{item.short}</option>)}</select></label></div></div>
      <div className="chartLegend">{shownMetrics.map(item=><span key={item.key}><i style={{background:item.color}}/>{item.short}</span>)}</div>
      {!data&&loading?<p className="empty">正在读取统计...</p>:departments.length===0?<p className="empty">暂无部门使用记录</p>:<div className="departmentChartViewport">
        <div className="departmentChart" style={{minWidth:`${Math.max(500,departments.length*100+40)}px`}}>
          <div className="chartYAxis">{[scale,scale*.75,scale*.5,scale*.25,0].map((value,index)=><span key={index}>{number(value)}</span>)}</div>
          <div className="chartColumns" style={{gridTemplateColumns:`repeat(${departments.length}, minmax(80px, 1fr))`}}>{departments.map(item=>{
            const total=heightOf(item)
            const description=`${item.name}：${shownMetrics.map(type=>`${type.short} ${number(item[type.key])} 次`).join('，')}`
            return <button className="chartColumn" type="button" key={item.key||item.id} title={description} aria-label={description} onClick={()=>{if(item.kind==='company'){setCompanyId(item.id);setDepartmentId('')}else if(!item.direct)setDepartmentId(item.id)}}><span className="chartBar" style={{height:`${total/scale*100}%`}}><span className="chartBarValue">{number(total)}</span>{shownMetrics.map(type=><span className="chartBarSegment" key={type.key} style={{background:type.color,height:`${total?item[type.key]/total*100:0}%`}}/>)}</span><span className="chartColumnLabel">{item.name}{item.direct?'（直属）':''}</span></button>
          })}</div>
        </div>
      </div>}
      <div className="statisticsFooter"><span>{key} · {data?.isArchived?'已归档':'累计统计'} · 更新于 {time(data?.archivedAt||data?.updatedAt)}</span><button className="ghost small" type="button" aria-expanded={details} onClick={()=>setDetails(!details)}><Table2 size={16}/>统计明细<ChevronDown size={16}/></button></div>
      {details&&<><div className="platformTableViewport"><table className="platformTable"><thead><tr><th>公司 / 部门</th>{metrics.map(item=><th key={item.key}>{item.short}</th>)}<th>合计</th></tr></thead><tbody>{departments.slice((page-1)*pageSize,page*pageSize).map(item=><tr key={item.key||item.id}><td>{item.name}{item.direct?'（直属）':''}</td>{metrics.map(type=><td key={type.key}>{number(item[type.key])}</td>)}<td>{number(item.total)}</td></tr>)}</tbody></table></div><Pagination page={page} totalPages={Math.max(1,Math.ceil(departments.length/pageSize))} total={departments.length} onChange={setPage}/></>}
    </div>
  </section>
}

function SearchField({value,onChange,placeholder='搜索姓名或账号'}) {
  return <label className="platformSearch"><Search size={17}/><input aria-label={placeholder} placeholder={placeholder} value={value} onChange={event=>onChange(event.target.value)}/></label>
}
function NameCell({user}) {return <div className="personName"><span>{user.builtin?'A':user.name.slice(0,1)}</span><strong>{user.name}</strong></div>}
function RoleBadges({user}) {return <div className="roleBadges">{user.roles.length?user.roles.map(role=><span key={role}>{roleNames[role]||role}</span>):<small>普通用户</small>}</div>}
function DepartmentCell({user}) {return <div className="departmentCell"><span>{user.departmentName}</span>{user.departmentPath&&<small>{user.departmentPath}</small>}</div>}

function OrganizationDirectory({api,directory,setNotice,pending,onReset}) {
  const [scope,setScope]=useState({kind:'all',id:''})
  const [companyFilter,setCompanyFilter]=useState('')
  const [treeSearch,setTreeSearch]=useState('')
  const [expanded,setExpanded]=useState([])
  const [view,setView]=useState('organizations')
  const [descendants,setDescendants]=useState(true)
  const [search,setSearch]=useState('')
  const query=useSearch(search)
  const [page,setPage]=useState(1)
  const [orgPage,setOrgPage]=useState(1)
  const [users,setUsers]=useState({items:[],total:0,totalPages:1})
  const [loading,setLoading]=useState(false)
  const companies=directory.companies||[]
  const map=new Map(directory.items.map(item=>[item.id,item]))
  const selected=scope.kind==='company'?companies.find(item=>item.id===scope.id):map.get(scope.id)
  const company=scope.kind==='company'?selected:companies.find(item=>item.id===selected?.companyId)
  const companyId=scope.kind==='all'?'':company?.id||''
  const departmentId=scope.kind==='department'?scope.id:''
  useEffect(()=>{
    if(view!=='people')return
    const controller=new AbortController()
    setLoading(true)
    api(`/api/admin/users?${new URLSearchParams({companyId,departmentId,includeDescendants:String(descendants),q:query,page:String(page)})}`,{signal:controller.signal}).then(setUsers).catch(error=>{if(!controller.signal.aborted)setNotice(error.message)}).finally(()=>{if(!controller.signal.aborted)setLoading(false)})
    return ()=>controller.abort()
  },[api,setNotice,view,companyId,departmentId,descendants,query,page,directory])
  function select(kind,id) {
    setScope({kind,id});setPage(1);setOrgPage(1);setSearch('');setDescendants(true);setView(kind==='all'?'organizations':'people')
    const node=map.get(id)
    if(kind==='department'&&node)setExpanded(current=>[...new Set([...current,...node.ancestors.slice(0,-1).map(item=>`department:${item.id}`)])])
  }
  const needle=treeSearch.trim().toLocaleLowerCase()
  function matches(node) {return !needle || node.name.toLocaleLowerCase().includes(needle) || node.childIds.some(id=>map.has(id)&&matches(map.get(id)))}
  function treeNode(node,kind,depth=0) {
    if(!matches(node))return null
    const key=`${kind}:${node.id}`,open=kind==='company'? !expanded.includes(key):expanded.includes(key)
    const children=node.childIds.map(id=>map.get(id)).filter(Boolean)
    const isOpen=open||Boolean(needle)
    return <div className="organizationNode" key={key} role="treeitem" aria-expanded={children.length?isOpen:undefined} aria-selected={scope.kind===kind&&scope.id===node.id}>
      <div className={`organizationRow ${scope.kind===kind&&scope.id===node.id?'selected':''}`} style={{paddingLeft:depth*14}}>
        {children.length?<button className="treeToggle" type="button" title={`${isOpen?'收起':'展开'}${node.name}`} aria-label={`${isOpen?'收起':'展开'}${node.name}`} onClick={()=>setExpanded(current=>current.includes(key)?current.filter(item=>item!==key):[...current,key])}>{isOpen?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button>:<span className="treeTogglePlaceholder"/>}
        <button className="treeSelect" type="button" title={node.path||node.name} onClick={()=>select(kind,node.id)}>{kind==='company'?<Building2 size={15}/>:<FolderTree size={15}/>}<span>{node.name}{node.ambiguous&&<small className="nodeId">#{node.id}</small>}</span><small>{number(node.employeeCount)}</small></button>
      </div>
      {isOpen&&children.length>0&&<div role="group">{children.map(child=>treeNode(child,'department',depth+1))}</div>}
    </div>
  }
  const childNodes=scope.kind==='all'?companies:(selected?.childIds||[]).map(id=>map.get(id)).filter(Boolean)
  const pageSize=10
  const path=scope.kind==='department'?[company,...selected?.ancestors.map(item=>map.get(item.id))||[]]:scope.kind==='company'?[company]:[]
  return <div className="organizationLayout fullOrganization">
    <aside className="organizationPanel"><h3><FolderTree size={17}/>组织目录</h3><select aria-label="组织公司" value={companyFilter} onChange={event=>{setCompanyFilter(event.target.value);setTreeSearch('');select(event.target.value?'company':'all',event.target.value)}}><option value="">全部公司</option>{companies.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select><SearchField value={treeSearch} onChange={setTreeSearch} placeholder="搜索公司或部门"/>
      <button className={`allCompanies ${scope.kind==='all'?'selected':''}`} type="button" onClick={()=>{setCompanyFilter('');select('all','')}}><Building2 size={16}/><span>全部公司</span><small>{number(directory.totalEmployees)}</small></button>
      <div className="organizationTree" role="tree" aria-label="公司与部门">{companies.filter(item=>!companyFilter||item.id===companyFilter).map(item=>treeNode(item,'company'))}</div>
      {!companies.length&&<p className="empty">同步后显示组织目录</p>}
    </aside>
    <div className="employeeDirectory" aria-busy={loading}>
      <nav className="organizationBreadcrumb" aria-label="组织路径"><button type="button" onClick={()=>select('all','')}>全部公司</button>{path.filter(Boolean).map((item,index)=><span key={`${index}:${item.id}`}><ChevronRight size={13}/><button type="button" onClick={()=>select(index===0?'company':'department',item.id)}>{item.name}</button></span>)}</nav>
      <div className="organizationHeading"><h3>{selected?.name||'全部公司'}</h3><span className="platformBadge neutral">{scope.kind==='all'?`${companies.length} 家公司 · ${directory.items.length} 个组织单元`:`${number(selected?.employeeCount)} 人（含下属） · 直属 ${number(selected?.directCount)} 人 · ${selected?.childIds.length||0} 个下属组织`}</span></div>
      <div className="directoryTabs" role="tablist" aria-label="组织内容"><button type="button" role="tab" aria-selected={view==='people'} onClick={()=>setView('people')}><Users size={16}/>人员</button><button type="button" role="tab" aria-selected={view==='organizations'} onClick={()=>setView('organizations')}><FolderTree size={16}/>{scope.kind==='all'?'公司概览':'下属组织'}</button></div>
      {view==='people'?<><div className="platformTools"><SearchField value={search} onChange={value=>{setSearch(value);setPage(1)}}/>{scope.kind==='department'&&<label className="descendantToggle"><input type="checkbox" checked={descendants} onChange={event=>{setDescendants(event.target.checked);setPage(1)}}/>含下属部门</label>}</div>
        <div className="platformTableViewport"><table className="platformTable"><thead><tr><th>姓名</th><th>账号</th><th>所属部门</th><th>角色</th><th>操作</th></tr></thead><tbody>{users.items.map(user=><tr key={user.id}><td><NameCell user={user}/></td><td>{user.username}</td><td><DepartmentCell user={user}/></td><td><RoleBadges user={user}/></td><td><button className="ghost small resetPassword" type="button" disabled={Boolean(pending)} onClick={()=>onReset(user)}><KeyRound size={14}/>重置密码</button></td></tr>)}</tbody></table></div>{!users.total&&<p className="empty">{loading?'正在读取人员...':'当前范围暂无人员'}</p>}<Pagination page={page} totalPages={users.totalPages} total={users.total} onChange={setPage}/>
      </>:<><div className="platformTableViewport"><table className="platformTable organizationTable"><thead><tr><th>{scope.kind==='all'?'公司名称':'组织名称'}</th>{scope.kind==='all'?<><th>一级部门</th><th>组织单元</th></>:<><th>直属人数</th><th>下级组织</th></>}<th>含下属人数</th><th>操作</th></tr></thead><tbody>{childNodes.slice((orgPage-1)*pageSize,orgPage*pageSize).map(item=><tr key={item.id}><td><button className="organizationLink" type="button" onClick={()=>select(scope.kind==='all'?'company':'department',item.id)}>{scope.kind==='all'?<Building2 size={16}/>:<FolderTree size={16}/>}<span>{item.name}{item.ambiguous&&<small className="nodeId">#{item.id}</small>}</span></button></td><td>{number(scope.kind==='all'?item.childIds.length:item.directCount)}</td><td>{number(scope.kind==='all'?item.departmentCount:item.childIds.length)}</td><td>{number(item.employeeCount)}</td><td><button className="iconButton" type="button" title={`查看${item.name}`} aria-label={`查看${item.name}`} onClick={()=>select(scope.kind==='all'?'company':'department',item.id)}><ChevronRight size={17}/></button></td></tr>)}</tbody></table></div>{!childNodes.length&&<p className="empty">暂无下属组织</p>}<Pagination page={orgPage} totalPages={Math.max(1,Math.ceil(childNodes.length/pageSize))} total={childNodes.length} pageSize={pageSize} onChange={setOrgPage}/></>}
    </div>
  </div>
}

function SyncDiagnostics({record}) {
  const diagnostics=record?.counts?.diagnostics
  const snapshot=record?.counts?.snapshot
  if (!diagnostics&&!snapshot) return null
  const fields={employeeId:'人员编号',code:'工号',name:'姓名',deptTopId:'一级部门',deptId:'所属部门',parentDeptId:'上级部门'}
  return <div className="syncDiagnostics">
    {diagnostics&&<p>接口记录 {number(diagnostics.sourceRecords)} 条 · 可用人员 {number(diagnostics.acceptedRecords)} 人 · 合并重复 {number(diagnostics.duplicateRecords)} 条 · 跳过异常 {number(diagnostics.skippedRecords)} 条</p>}
    {(diagnostics?.skippedRecords>0||diagnostics?.nameFallbacks>0)&&<p>缺人员编号 {number(diagnostics.missingEmployeeId)} 条 · 缺工号 {number(diagnostics.missingAccount)} 条 · 姓名兜底 {number(diagnostics.nameFallbacks)} 人 · 工号冲突 {number(diagnostics.conflictingAccounts)} 组 · 人员编号冲突 {number(diagnostics.conflictingEmployeeIds)} 组</p>}
    {record.counts.deactivationDeferred&&<p className="syncWarning">本次含异常记录，保留原账户与部门，暂不自动停用。</p>}
    {snapshot&&<p className="snapshotLocation"><span>{snapshot.captureStatus==='complete'?'原始接口数据已保存':'原始接口数据保存位置'}</span><code>{snapshot.directory}</code></p>}
    {diagnostics?.issues?.length>0&&<details><summary><History size={15}/>异常明细（{diagnostics.issues.length} 个示例）</summary>
      <div className="platformTableViewport"><table className="platformTable"><thead><tr><th>记录位置</th><th>字段</th><th>问题</th></tr></thead><tbody>{diagnostics.issues.map((item,index)=><tr key={index}><td>第 {item.rowNumbers.join('、')} 条</td><td>{item.fields.map(field=>fields[field]||field).join('、')||'记录结构'}</td><td className="diagnosticMessage">{item.message}<small>{[item.employeeFingerprint?`人员指纹 ${item.employeeFingerprint}`:'',item.accountFingerprint?`账号指纹 ${item.accountFingerprint}`:''].filter(Boolean).join(' · ')}</small></td></tr>)}</tbody></table></div>
      {diagnostics.columnNames?.length>0&&<p className="diagnosticColumns">接口字段：{diagnostics.columnNames.join('、')}</p>}
    </details>}
  </div>
}

export function PermissionsCenter({api,me,setNotice,onUserChanged}) {
  const [tab,setTab]=useState('roles')
  const [roles,setRoles]=useState([])
  const [roleId,setRoleId]=useState('super_admin')
  const [roleSearch,setRoleSearch]=useState('')
  const roleQuery=useSearch(roleSearch)
  const [rolePage,setRolePage]=useState(1)
  const [members,setMembers]=useState({items:[],total:0,totalPages:1})
  const [directory,setDirectory]=useState({items:[],companies:[],totalEmployees:0})
  const [sync,setSync]=useState(null)
  const [revision,setRevision]=useState(0)
  const [pending,setPending]=useState('')
  const [memberOpen,setMemberOpen]=useState(false)
  const [candidateSearch,setCandidateSearch]=useState('')
  const candidateQuery=useSearch(candidateSearch)
  const [candidatePage,setCandidatePage]=useState(1)
  const [candidates,setCandidates]=useState({items:[],total:0,totalPages:1})
  const [selected,setSelected]=useState([])
  const [loading,setLoading]=useState(false)
  const lastSuccess=useRef(null)

  useEffect(()=>{
    if (!me.isSuperAdmin) return
    let cancelled=false
    setLoading(true)
    Promise.all([api('/api/admin/roles'),api('/api/admin/departments'),api('/api/admin/organization-sync')]).then(([roleData,departmentData,syncData])=>{
      if(cancelled)return
      setRoles(roleData.items);setDirectory(departmentData);setSync(syncData)
    }).catch(error=>{if(!cancelled)setNotice(error.message)}).finally(()=>{if(!cancelled)setLoading(false)})
    return ()=>{cancelled=true}
  },[api,me.isSuperAdmin,setNotice,revision])

  useEffect(()=>{
    if (!me.isSuperAdmin || tab!=='roles') return
    const controller=new AbortController()
    api(`/api/admin/roles/${roleId}/members?${new URLSearchParams({q:roleQuery,page:String(rolePage)})}`,{signal:controller.signal}).then(setMembers).catch(error=>{if(!controller.signal.aborted)setNotice(error.message)})
    return ()=>controller.abort()
  },[api,me.isSuperAdmin,setNotice,tab,roleId,roleQuery,rolePage,revision])

  useEffect(()=>{
    if (!sync?.running || tab!=='users') return
    const controller=new AbortController()
    const timer=setInterval(()=>api('/api/admin/organization-sync',{signal:controller.signal}).then(setSync).catch(error=>{if(!controller.signal.aborted)setNotice(error.message)}),2000)
    return ()=>{clearInterval(timer);controller.abort()}
  },[api,setNotice,sync?.running,tab])

  useEffect(()=>{
    const id=sync?.lastSuccess?.id
    if (id && lastSuccess.current!==id) {lastSuccess.current=id;setRevision(value=>value+1)}
  },[sync?.lastSuccess?.id])

  useEffect(()=>{
    if (!memberOpen) return
    const controller=new AbortController()
    api(`/api/admin/users?${new URLSearchParams({q:candidateQuery,page:String(candidatePage)})}`,{signal:controller.signal}).then(setCandidates).catch(error=>{if(!controller.signal.aborted)setNotice(error.message)})
    return ()=>controller.abort()
  },[api,setNotice,memberOpen,candidateQuery,candidatePage])

  async function mutate(key,action,message) {
    setPending(key)
    try {await action();setRevision(value=>value+1);await onUserChanged();setNotice(message)} catch(error) {setNotice(error.message)} finally {setPending('')}
  }

  if (!me.isSuperAdmin) return <section className="workspace"><h2>权限中心仅供超级管理员使用</h2></section>
  const role=roles.find(item=>item.id===roleId)
  const syncHasWarnings=sync?.lastRun?.status==='completed'&&sync?.lastRun?.counts?.diagnostics?.skippedRecords>0
  return <section className="permissionsCenter" aria-busy={loading}>
    <div className="permissionBreadcrumb">工作台<ChevronRight size={14}/>权限中心<ChevronRight size={14}/>{tab==='roles'?'角色管理':'用户管理'}</div>
    <div className="permissionLayout"><aside className="permissionSidebar"><p>权限中心</p><button className={tab==='roles'?'selected':''} type="button" onClick={()=>setTab('roles')}><ShieldCheck size={18}/>角色管理</button><button className={tab==='users'?'selected':''} type="button" onClick={()=>setTab('users')}><Users size={18}/>用户管理</button></aside>
      <div className="permissionBody">
        {tab==='roles'?<>
          <div className="permissionTitle"><div><h2>角色管理</h2><p>{roles.length} 个预设角色</p></div><span className="platformBadge"><ShieldCheck size={15}/>超级管理员</span></div>
          <div className="roleTabs" role="tablist" aria-label="管理员角色">{roles.map(item=><button type="button" role="tab" aria-selected={roleId===item.id} className={roleId===item.id?'selected':''} key={item.id} onClick={()=>{setRoleId(item.id);setRolePage(1);setRoleSearch('')}}>{item.id==='super_admin'?item.name:item.name.replace('管理员','')}<small>{item.memberCount}</small></button>)}</div>
          <div className="roleScope"><span>权限范围</span>{role?.permissions.map(permission=><span className="scopeBadge" key={permission}>{permissionNames[permission]||permission}</span>)}</div>
          <div className="platformTools"><SearchField value={roleSearch} onChange={value=>{setRoleSearch(value);setRolePage(1)}}/><button className="primary small" type="button" onClick={()=>{setSelected([]);setCandidateSearch('');setCandidatePage(1);setMemberOpen(true)}}><UserPlus size={17}/>添加成员</button></div>
          <div className="platformTableViewport"><table className="platformTable"><thead><tr><th>姓名 / 昵称</th><th>账号</th><th>部门 / 公司</th><th>操作</th></tr></thead><tbody>{members.items.map(user=><tr key={user.id}><td><NameCell user={user}/></td><td>{user.username}</td><td><DepartmentCell user={user}/></td><td>{user.builtin?<small>内置超管</small>:<button className="iconButton danger" type="button" title={`移除 ${user.name}`} aria-label={`移除 ${user.name}`} disabled={Boolean(pending)} onClick={()=>{if(window.confirm(`将 ${user.name} 从${role?.name}中移除？`)) mutate(user.id,()=>api(`/api/admin/roles/${roleId}/members/${encodeURIComponent(user.id)}`,{method:'DELETE'}),'角色成员已移除')}}><Trash2 size={17}/></button>}</td></tr>)}</tbody></table></div>
          {!members.total&&<p className="empty">暂无角色成员</p>}<Pagination page={rolePage} totalPages={members.totalPages} total={members.total} onChange={setRolePage}/>
        </>:<>
          <div className="permissionTitle"><div><h2>用户管理</h2><p>公司 / 组织与人员</p></div><span className="platformBadge neutral">{directory.companies.length} 家公司 · {directory.items.length} 个组织单元 · {number(directory.totalEmployees)} 人</span></div>
          <div className="syncSummary"><div><p>{sync?.lastRun?<span className={`syncBadge ${syncHasWarnings?'warning':sync.lastRun.status}`}><CheckCircle2 size={15}/>{sync.lastRun.status==='running'?'正在同步':sync.lastRun.status==='failed'?'同步失败':syncHasWarnings?'完成（含异常）':'同步成功'}</span>:<span className="mutedText">尚未同步</span>}<span>上次成功：{time(sync?.lastSuccess?.finishedAt)}</span></p><small>下次自动同步：{time(sync?.nextRun)}</small>{sync?.running&&<p className="syncStage">{sync.lastRun?.stage}</p>}{sync?.lastRun?.error&&<p className="formError">{sync.lastRun.error}</p>}</div><button className="ghost syncButton" type="button" disabled={sync?.running||Boolean(pending)} onClick={()=>mutate('sync',async()=>{await api('/api/admin/organization-sync',{method:'POST'});setSync(await api('/api/admin/organization-sync'))},'人员同步已开始')}><RefreshCw className={sync?.running?'spinning':''} size={17}/>{sync?.running?'同步中...':'同步人员与部门'}</button></div>
          <SyncDiagnostics record={sync?.lastRun}/>
          <OrganizationDirectory api={api} directory={directory} setNotice={setNotice} pending={pending} onReset={user=>{if(window.confirm(`将 ${user.name} 的密码重置为 123456？下次登录需要修改密码。`))mutate(user.id,()=>api(`/api/admin/users/${encodeURIComponent(user.id)}/reset-password`,{method:'POST'}),'密码已重置，下次登录需要改密')}}/>
          <details className="syncHistory"><summary><History size={16}/>最近同步记录</summary><div>{sync?.items.map(item=><article key={item.id}><strong>{time(item.startedAt)}</strong><span>{item.trigger==='manual'?'手动同步':'自动同步'} · {item.status==='completed'?(item.counts.diagnostics?.skippedRecords?'完成（含异常）':'成功'):item.status==='failed'?'失败':'进行中'}</span><p>{item.status==='completed'?`部门 ${item.counts.departments} 个 / 人员 ${item.counts.employees} 人 / 新增 ${item.counts.added} 人 / 更新 ${item.counts.updated} 人 / 停用账户 ${item.counts.disabled} 个`:item.error||item.stage}</p><SyncDiagnostics record={item}/></article>)}</div></details>
        </>}
      </div>
    </div>
    {memberOpen&&<div className="dialogBackdrop" onMouseDown={()=>setMemberOpen(false)}><section className="dialog addMemberDialog" role="dialog" aria-modal="true" aria-label="添加角色成员" onMouseDown={event=>event.stopPropagation()}><div className="dialogHead"><h2>添加角色成员</h2><button type="button" className="iconButton" title="关闭" aria-label="关闭" onClick={()=>setMemberOpen(false)}><X size={18}/></button></div><span className="platformBadge">{role?.name}</span><SearchField value={candidateSearch} onChange={value=>{setCandidateSearch(value);setCandidatePage(1)}}/><div className="memberCandidates">{candidates.items.map(user=><label key={user.id}><input type="checkbox" disabled={user.roles.includes(roleId)} checked={user.roles.includes(roleId)||selected.includes(user.id)} onChange={event=>setSelected(current=>event.target.checked?[...current,user.id]:current.filter(id=>id!==user.id))}/><span><strong>{user.name}</strong><small>{user.username}</small></span><small>{user.departmentPath||user.departmentName}</small></label>)}</div>{!candidates.total&&<p className="empty">没有匹配的员工</p>}<Pagination page={candidatePage} totalPages={candidates.totalPages} total={candidates.total} onChange={setCandidatePage}/><div className="memberDialogActions"><span>已选择 {selected.length} 人</span><button className="primary" type="button" disabled={!selected.length||Boolean(pending)} onClick={()=>mutate('members',async()=>{await api(`/api/admin/roles/${roleId}/members`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userIds:selected})});setMemberOpen(false)},'角色成员已添加')}><Plus size={17}/>添加</button></div></section></div>}
  </section>
}

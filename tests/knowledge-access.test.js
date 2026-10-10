import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import initSqlJs from 'sql.js'
import {organizationIndex} from '../server/organization.js'
import {publicKnowledgeAssistants, visibleKnowledgeAssistants} from '../server/knowledge-assistants.js'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const companyName = '西部超导材料科技股份有限公司'
const wireCompanyName = '西安聚能超导线材科技有限公司'
const companies = [{id:'100',name:companyName},{id:'200',name:'测试子公司'},{id:'500',name:wireCompanyName}]
const departments = [
  {id:'189',name:'制造一厂',companyId:'100',parentId:null},
  {id:'melt',name:'熔炼车间',companyId:'100',parentId:'189'},
  {id:'melt-team',name:'熔炼班组',companyId:'100',parentId:'melt'},
  {id:'190',name:'制造二厂',companyId:'100',parentId:null},
  {id:'192',name:'制造四厂',companyId:'100',parentId:null},
  {id:'four-team',name:'四厂车间',companyId:'100',parentId:'192'},
  {id:'174',name:'信息技术部',companyId:'100',parentId:null},
  {id:'it-team',name:'系统运维室',companyId:'100',parentId:'174'},
  {id:'193',name:'高管',companyId:'100',parentId:null},
  {id:'quality',name:'技术质量部',companyId:'100',parentId:null},
  {id:'other-one',name:'制造一厂',companyId:'200',parentId:null},
  {id:'150',name:'高管',companyId:'200',parentId:null},
  {id:'other-it',name:'信息技术部',companyId:'200',parentId:null},
  {id:'wire-office',name:'综合办公室',companyId:'500',parentId:null},
  {id:'wire-team',name:'办公室班组',companyId:'500',parentId:'wire-office'},
  {id:'243',name:'高管',companyId:'500',parentId:null},
  {id:'wire-it',name:'信息技术部',companyId:'500',parentId:null},
]
const organization = organizationIndex(companies,departments)
const user = (departmentId, companyId='100', extra={}) => ({companyId,departmentId,builtin:false,isSuperAdmin:false,...extra})
const ids = value => visibleKnowledgeAssistants(value,organization).map(item=>item.id)
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms))

test('Knowledge catalog follows exact company and actual department ancestry, not auxiliary labels',()=>{
  assert.deepEqual(ids(user('189')),['qa'])
  assert.deepEqual(ids(user('melt-team')),['qa'])
  assert.deepEqual(ids(user('four-team')),['ragflow'])
  assert.deepEqual(ids(user('174')),['qa','ragflow'])
  assert.deepEqual(ids(user('it-team')),['qa','ragflow'])
  assert.deepEqual(ids(user('193')),['qa','ragflow'])
  assert.deepEqual(ids(user('190')),[])
  assert.deepEqual(ids(user('quality','100',{topDepartmentId:'193',departmentPath:'高管 / 信息技术部'})),[])
  assert.deepEqual(ids(user('other-one','200')),[])
  assert.deepEqual(ids(user('150','200')),[])
  assert.deepEqual(ids(user('other-it','200')),[])
  assert.deepEqual(ids(user('174','200')),[])
  assert.deepEqual(ids(user(null)),[])
  assert.deepEqual(ids(null),[])
})

test('Wire company-wide access grants only plant four and preserves primary-company policy',()=>{
  for(const departmentId of ['wire-office','wire-team','243','wire-it',null])assert.deepEqual(ids(user(departmentId,'500')),['ragflow'])
  assert.deepEqual(ids(user('melt','500')),[])
  const renamed=organizationIndex([{id:'500',name:'另一家公司'}],departments.filter(item=>item.companyId==='500'))
  assert.deepEqual(visibleKnowledgeAssistants(user('wire-office','500'),renamed),[])
  const sameName=organizationIndex([{id:'200',name:wireCompanyName}],departments.filter(item=>item.companyId==='200'))
  assert.deepEqual(visibleKnowledgeAssistants(user('150','200'),sameName),[])
  assert.deepEqual(ids(user('four-team')),['ragflow'])
  assert.deepEqual(ids(user('174')),['qa','ragflow'])
  assert.deepEqual(ids(user('193')),['qa','ragflow'])
})

test('Only the built-in super administrator bypasses department scope; management roles do not grant chat access',()=>{
  assert.deepEqual(ids(user('189','100',{isSuperAdmin:true})),['qa'])
  assert.deepEqual(ids(user('150','200',{isSuperAdmin:true})),[])
  assert.deepEqual(ids(user(null,null,{builtin:true,isSuperAdmin:true})),['qa','ragflow'])
  assert.deepEqual(ids(user(null,null,{builtin:true})),[])
  const catalog=publicKnowledgeAssistants(user('174'),organization)
  assert.equal(catalog.length,2)
  assert.ok(catalog.every(item=>!('companyId' in item)&&!('departmentId' in item)&&!('apiKey' in item)&&!('url' in item)))
})

test('Inconsistent company names or cross-company ancestry fail closed',()=>{
  const renamed=organizationIndex([{id:'100',name:'另一家公司'}],departments.filter(item=>item.companyId==='100'))
  assert.deepEqual(visibleKnowledgeAssistants(user('174'),renamed),[])
  const mixed=organizationIndex(companies,[...departments,{id:'invalid',name:'异常组织',companyId:'100',parentId:'150'}])
  assert.deepEqual(visibleKnowledgeAssistants(user('invalid'),mixed),[])
})

test('Knowledge HTTP authorization, feedback snapshots and additive legacy migration integrate end to end',async(t)=>{
  const SQL=await initSqlJs()
  const db=new SQL.Database()
  db.run(`CREATE TABLE companies(id TEXT PRIMARY KEY,name TEXT,active INTEGER DEFAULT 1,updated_at TEXT);
    CREATE TABLE departments(id TEXT PRIMARY KEY,name TEXT,company_id TEXT,parent_id TEXT,active INTEGER DEFAULT 1,updated_at TEXT);
    CREATE TABLE users(id TEXT PRIMARY KEY,employee_id TEXT UNIQUE,username TEXT UNIQUE,name TEXT,department_id TEXT,company_id TEXT,
      password_hash TEXT,must_change_password INTEGER DEFAULT 0,auth_version INTEGER DEFAULT 1,builtin INTEGER DEFAULT 0,active INTEGER DEFAULT 1,created_at TEXT,updated_at TEXT);
    CREATE TABLE user_roles(user_id TEXT,role_id TEXT,created_at TEXT,PRIMARY KEY(user_id,role_id));
    CREATE TABLE feedback(id INTEGER PRIMARY KEY AUTOINCREMENT,content TEXT,reply TEXT,created_at TEXT,replied_at TEXT);
    INSERT INTO feedback VALUES(9,'旧反馈正文','原回复','2020-01-01','2020-01-02');`)
  for(const item of companies)db.run('INSERT INTO companies(id,name,updated_at)VALUES(?,?,?)',[item.id,item.name,'old'])
  for(const item of departments)db.run('INSERT INTO departments(id,name,company_id,parent_id,updated_at)VALUES(?,?,?,?,?)',[item.id,item.name,item.companyId,item.parentId,'old'])
  const hash='knowledge-salt:'+crypto.scryptSync('knowledge-test-password','knowledge-salt',32).toString('hex')
  const fixtures=[['one','一厂测试员工','melt-team','100'],['four','四厂测试员工','four-team','100'],
    ['it','信息部测试员工','it-team','100'],['executive','高管测试员工','193','100'],
    ['two','二厂测试员工','190','100'],['subsidiary','子公司测试员工','150','200'],
    ['wire','线材办公室测试员工','wire-team','500'],['wire-executive','线材高管测试员工','243','500'],['wire-unassigned','线材公司直属测试员工',null,'500']]
  for(const [id,name,departmentId,companyId] of fixtures)db.run(`INSERT INTO users(id,employee_id,username,name,department_id,company_id,password_hash,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?)`,['mdm:'+id,id,id,name,departmentId,companyId,hash,'old','old'])
  db.run("INSERT INTO user_roles VALUES('mdm:one','glossary_admin','old'),('mdm:subsidiary','super_admin','old')")
  const storage=await fs.mkdtemp(path.join(os.tmpdir(),'aizhushou-knowledge-access-'))
  await fs.writeFile(path.join(storage,'aizhushou.sqlite'),Buffer.from(db.export()));db.close()
  const reservation=http.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve))
  const portalFixture=http.createServer((req,res)=>{
    const account={'portal-four':'four','portal-it':'it','portal-subsidiary':'subsidiary','portal-wire':'wire'}[new URL(req.url,'http://localhost').searchParams.get('ticket')]
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(account?{data:account}:{code:500,data:null}))
  })
  await new Promise(resolve=>portalFixture.listen(0,'127.0.0.1',resolve))
  t.after(async()=>{portalFixture.closeAllConnections();await new Promise(resolve=>portalFixture.close(resolve))})
  const child=spawn(process.execPath,['server/index.js'],{cwd:project,windowsHide:true,env:{...process.env,STORAGE_DIR:storage,SERVER_PORT:String(port),MOCK_AI:'true',ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'knowledge-test-admin',SESSION_SECRET:'knowledge-test-session',SSO_ENABLED:'true',SSO_CHECK_TICKET_URL:`http://127.0.0.1:${portalFixture.address().port}/sso/checkTicket`,RAGFLOW_CHAT_URL:'http://ragflow.test/chat/share?auth=fixture',PLATFORM_SCHEDULER_DISABLED:'true'}})
  let logs='';child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk)
  t.after(async()=>{if(child.exitCode!==null||child.signalCode!==null)return;child.kill();await new Promise(resolve=>child.once('exit',resolve))})
  const origin=`http://127.0.0.1:${port}`
  let healthy=false
  for(let tries=0;tries<300;tries++){try{if((await fetch(origin+'/api/health')).ok){healthy=true;break}}catch{}if(child.exitCode!==null)throw new Error(logs);await pause(50)}
  assert.ok(healthy,logs)
  async function request(endpoint,{client,method='GET',body,expected=200,redirect='follow'}={}){
    const response=await fetch(origin+endpoint,{method,redirect,headers:{...(client?.cookie?{Cookie:client.cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined})
    const cookies=response.headers.getSetCookie();if(client&&cookies.length)client.cookie=cookies[0].split(';')[0]
    assert.equal(response.status,expected,await response.clone().text())
    return response
  }
  const clients={}
  for(const [id] of fixtures){const client={};clients[id]=client;await request('/api/login',{method:'POST',client,body:{username:id,password:'knowledge-test-password'}})}
  const admin={};await request('/api/login',{method:'POST',client:admin,body:{username:'admin',password:'knowledge-test-admin'}})
  for(const [id,expected] of [['one',['qa']],['four',['ragflow']],['it',['qa','ragflow']],['executive',['qa','ragflow']],['two',[]],['subsidiary',[]],['wire',['ragflow']],['wire-executive',['ragflow']],['wire-unassigned',['ragflow']]]){
    const response=await request('/api/me',{client:clients[id]});assert.equal(response.headers.get('Cache-Control'),'no-store')
    assert.deepEqual((await response.json()).knowledgeAssistants.map(item=>item.id),expected)
  }
  assert.deepEqual((await(await request('/api/me',{client:admin})).json()).knowledgeAssistants.map(item=>item.id),['qa','ragflow'])
  for(const [ticket,expected] of [['portal-four',['ragflow']],['portal-it',['qa','ragflow']],['portal-subsidiary',[]],['portal-wire',['ragflow']]]){
    const portalClient={};await request('/api/sso/login?ticket='+ticket,{client:portalClient})
    const profile=await(await request('/api/me',{client:portalClient})).json()
    assert.equal(profile.authMethod,'portal');assert.deepEqual(profile.knowledgeAssistants.map(item=>item.id),expected)
  }
  await request('/api/qa/chat',{method:'POST',body:{messages:[{role:'user',content:'test'}]},expected:401})
  for(const id of ['four','two','subsidiary','wire','wire-executive','wire-unassigned'])for(const endpoint of ['/api/qa/chat','/api/qa/chat/stream','/api/usage/qa']){
    const response=await request(endpoint,{client:clients[id],method:'POST',body:{messages:[{role:'user',content:'test'}],companyId:'100',departmentId:'189',userId:'one',requestId:'forged'},expected:403})
    assert.equal((await response.json()).code,'KNOWLEDGE_ASSISTANT_FORBIDDEN')
  }
  for(const id of ['one','two','subsidiary']){
    await request('/api/ragflow/chat/stream',{client:clients[id],method:'POST',body:{question:'test'},expected:403})
    await request('/api/usage/ragflow',{client:clients[id],method:'POST',body:{requestId:'forged'},expected:403})
    await request('/api/assistants/ragflow/open?count=0',{client:clients[id],expected:403,redirect:'manual'})
  }
  const statsBefore=await(await request('/api/stats')).json();assert.equal(statsBefore.qaNativeUses,0);assert.equal(statsBefore.ragflowUses,0)
  const native=await request('/api/qa/chat/stream',{client:clients.one,method:'POST',body:{messages:[{role:'user',content:'native test'}]}});assert.ok((await native.text()).includes('"type":"done"'))
  for(const id of ['four','wire','wire-executive','wire-unassigned']){
    const ragflow=await request('/api/ragflow/chat/stream',{client:clients[id],method:'POST',body:{question:'ragflow test'}});assert.ok((await ragflow.text()).includes('"type":"done"'))
    const opened=await request('/api/assistants/ragflow/open?count=0',{client:clients[id],expected:302,redirect:'manual'});assert.ok(opened.headers.get('Location').startsWith('http://ragflow.test/'))
  }
  for(const id of ['it','executive'])for(const assistant of ['qa','ragflow'])await request('/api/usage/'+assistant,{client:clients[id],method:'POST',body:{requestId:`${id}-${assistant}`}})
  await request('/api/feedback',{client:clients.one,method:'POST',body:{content:'身份快照反馈',authorName:'伪造姓名',authorDepartmentName:'制造四厂',authorUserId:'four'}})
  const feedback=(await(await request('/api/feedback')).json()).items
  const posted=feedback.find(item=>item.content==='身份快照反馈'),legacy=feedback.find(item=>item.id===9)
  assert.equal(posted.authorName,'一厂测试员工');assert.equal(posted.authorDepartmentName,'熔炼班组')
  assert.equal(posted.authorDepartmentPath,companyName+' / 制造一厂 / 熔炼车间 / 熔炼班组')
  assert.equal(legacy.authorName,null);assert.equal(legacy.authorDepartmentName,null);assert.equal(legacy.reply,'原回复')
  await request('/api/feedback/'+posted.id+'/reply',{client:clients.one,method:'PATCH',body:{reply:'not allowed'},expected:403})
  const backups=(await fs.readdir(path.join(storage,'backups'))).filter(name=>name.startsWith('before-feedback-authors-'));assert.equal(backups.length,1)
  const backup=new SQL.Database(await fs.readFile(path.join(storage,'backups',backups[0])));assert.equal(backup.exec('SELECT content FROM feedback')[0].values[0][0],'旧反馈正文');backup.close()

  // Reassign through the real synchronization path so organization cache invalidation is exercised.
  const departmentResponse=departments.map(item=>({deptId:item.id,departmentName:item.name,companyId:item.companyId,companyIdDesc:companies.find(company=>company.id===item.companyId).name,parentDeptId:item.parentId}))
  const employeeResponse=fixtures.map(([id,name,departmentId,companyId])=>({employeeId:id,code:id,name:id==='one'?'调动后姓名':name,deptId:id==='one'?'four-team':departmentId,companyId}))
  const fixture=http.createServer(async(req,res)=>{
    for await(const _chunk of req) {}
    res.setHeader('Content-Type','application/json')
    if(req.url==='/oauth/oauth/token')res.end(JSON.stringify({access_token:'knowledge-fixture-token',expires_in:3600}))
    else {const records=req.url.endsWith('department')?departmentResponse:employeeResponse;res.end(JSON.stringify({status:'S',page:0,size:200,totalElements:records.length,totalPages:1,responseData:records}))}
  })
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve))
  t.after(async()=>{fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve))})
  child.kill();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve))
  const restarted=spawn(process.execPath,['server/index.js'],{cwd:project,windowsHide:true,env:{...process.env,STORAGE_DIR:storage,SERVER_PORT:String(port),MOCK_AI:'true',ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'knowledge-test-admin',SESSION_SECRET:'knowledge-test-session',MDM_API_BASE_URL:`http://127.0.0.1:${fixture.address().port}`,MDM_CLIENT_ID:'fixture',MDM_CLIENT_SECRET:'fixture',PLATFORM_SCHEDULER_DISABLED:'true'}})
  restarted.stdout.on('data',chunk=>logs+=chunk);restarted.stderr.on('data',chunk=>logs+=chunk)
  t.after(async()=>{restarted.kill();await new Promise(resolve=>restarted.exitCode!==null?resolve():restarted.once('exit',resolve))})
  for(let tries=0;tries<300;tries++){try{if((await fetch(origin+'/api/health')).ok)break}catch{}await pause(50)}
  await request('/api/admin/organization-sync',{client:admin,method:'POST',expected:202})
  let sync
  for(let tries=0;tries<200;tries++){sync=await(await request('/api/admin/organization-sync',{client:admin})).json();if(!sync.running)break;await pause(30)}
  assert.equal(sync.lastRun.status,'completed',JSON.stringify(sync))
  assert.deepEqual((await(await request('/api/me',{client:clients.one})).json()).knowledgeAssistants.map(item=>item.id),['ragflow'])
  await request('/api/qa/chat/stream',{client:clients.one,method:'POST',body:{messages:[{role:'user',content:'test'}]},expected:403})
  const preserved=(await(await request('/api/feedback')).json()).items.find(item=>item.id===posted.id)
  assert.equal(preserved.authorName,posted.authorName);assert.equal(preserved.authorDepartmentPath,posted.authorDepartmentPath)
  assert.equal((await fs.readdir(path.join(storage,'backups'))).filter(name=>name.startsWith('before-feedback-authors-')).length,1)
})

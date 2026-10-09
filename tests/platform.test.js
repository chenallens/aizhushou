import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import initSqlJs from 'sql.js'
import { latestWeeklySlot, nextWeeklySlot } from '../server/platform.js'
import { createUsageStats, periodBounds, shanghaiDate } from '../server/usage-stats.js'

const projectDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const SQL=await initSqlJs()
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))

test('Shanghai calendar and Monday 04:00 schedule',()=>{
  assert.equal(latestWeeklySlot(new Date('2026-10-09T12:00:00+08:00')),'2026-10-04T20:00:00.000Z')
  assert.equal(latestWeeklySlot(new Date('2026-10-12T03:59:59+08:00')),'2026-10-04T20:00:00.000Z')
  assert.equal(latestWeeklySlot(new Date('2026-10-12T04:00:00+08:00')),'2026-10-11T20:00:00.000Z')
  assert.equal(nextWeeklySlot(new Date('2026-10-09T12:00:00+08:00')),'2026-10-11T20:00:00.000Z')
  assert.deepEqual(periodBounds('month','2026-10'),{start:'2026-09-30T16:00:00.000Z',end:'2026-10-31T16:00:00.000Z'})
  assert.equal(periodBounds('year','2026').end,'2026-12-31T16:00:00.000Z')
})

test('Monthly and annual archives run at 04:00, are idempotent and preserve legacy attribution',()=>{
  const db=new SQL.Database()
  db.run('CREATE TABLE events (id INTEGER PRIMARY KEY,type TEXT,created_at TEXT,department_id TEXT,department_name TEXT); CREATE TABLE companies(id TEXT,name TEXT,active INTEGER); CREATE TABLE departments (id TEXT,name TEXT,active INTEGER,company_id TEXT,parent_id TEXT); CREATE TABLE statistics_archives (period TEXT,period_key TEXT,data_json TEXT,archived_at TEXT,PRIMARY KEY(period,period_key));')
  db.run("INSERT INTO events VALUES (1,'qa_click','2026-10-10T04:00:00.000Z',NULL,NULL),(2,'translation_click','2026-10-15T04:00:00.000Z','p1','制造一厂'),(3,'standard_click','2025-12-31T15:59:59.000Z','p2','制造二厂')")
  const all=(sql,params=[])=>{const stmt=db.prepare(sql);stmt.bind(params);const result=[];while(stmt.step())result.push(stmt.getAsObject());stmt.free();return result}
  const get=(sql,params=[])=>all(sql,params)[0]||null
  const stats=createUsageStats({all,get,run:(sql,params)=>db.run(sql,params)})
  stats.archiveDue(new Date('2026-11-01T03:59:59+08:00'))
  assert.equal(get("SELECT * FROM statistics_archives WHERE period='month' AND period_key='2026-10'"),null)
  stats.archiveDue(new Date('2026-11-01T04:00:00+08:00'))
  const october=get("SELECT * FROM statistics_archives WHERE period='month' AND period_key='2026-10'")
  const data=JSON.parse(october.data_json)
  assert.equal(data.totals.total,2)
  assert.equal(data.departments.find(item=>item.id==='legacy').qaNativeUses,1)
  stats.archiveDue(new Date('2026-11-01T04:01:00+08:00'))
  assert.equal(get("SELECT COUNT(*) AS count FROM statistics_archives WHERE period='month' AND period_key='2026-10'").count,1)
  stats.archiveDue(new Date('2027-01-01T03:59:59+08:00'))
  assert.equal(get("SELECT * FROM statistics_archives WHERE period='year' AND period_key='2026'"),null)
  stats.archiveDue(new Date('2027-01-01T04:00:00+08:00'))
  assert.equal(JSON.parse(get("SELECT * FROM statistics_archives WHERE period='year' AND period_key='2026'").data_json).totals.total,2)
  db.close()
})

test('Platform integration: migration, organization, accounts, roles, stats and public feedback',async(t)=>{
  const storage=await fs.mkdtemp(path.join(os.tmpdir(),'aizhushou-test-'))
  const legacyDb=new SQL.Database()
  legacyDb.run('CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,created_at TEXT NOT NULL)')
  const month=currentMonth()
  const previousMonth=shanghaiDate(new Date(new Date(periodBounds('month',month).start).getTime()-1)).slice(0,7)
  legacyDb.run('INSERT INTO events(type,created_at) VALUES (?,?)',['qa_click',periodBounds('month',previousMonth).start])
  await fs.writeFile(path.join(storage,'aizhushou.sqlite'),Buffer.from(legacyDb.export()))
  legacyDb.close()

  const departments=[
    {deptId:'company',departmentName:'总公司',companyId:'company',companyIdDesc:'总公司'},
    {deptId:'p1',departmentName:'制造一厂',parentDeptId:'company',companyId:'company'},
    {deptId:'p2',departmentName:'制造二厂',parentDeptId:'company',companyId:'company'},
    {deptId:'p3',departmentName:'制造三厂',parentDeptId:'company',companyId:'company'},
    {deptId:'p4',departmentName:'制造四厂',parentDeptId:'company',companyId:'company'},
    {deptId:'quality',departmentName:'技术质量部',parentDeptId:'company',companyId:'company'},
    {deptId:'melt',departmentName:'熔炼车间',parentDeptId:'p1',companyId:'company'},
  ]
  let employees=Array.from({length:6},(_,index)=>({employeeId:`e${index+1}`,code:`oa100${index+1}`,name:['张明','李敏','王磊','陈静','赵婷','杨帆'][index],deptId:index<3?'melt':index===3?'p2':'quality',deptTopId:index<3?'p1':index===3?'p2':'quality'}))
  let fail=false,partial=false,authorizationRetry=true,tokenRequests=0
  const requestedPaths=[]
  const fixture=http.createServer(async(req,res)=>{
    const body=[];for await (const chunk of req) body.push(chunk)
    const text=Buffer.concat(body).toString()
    requestedPaths.push(req.url)
    res.setHeader('Content-Type','application/json')
    if(req.url==='/oauth/oauth/token') {
      assert.equal(new URLSearchParams(text).get('grant_type'),'client_credentials')
      tokenRequests++
      res.end(JSON.stringify({access_token:`fixture-${tokenRequests}`,expires_in:3600}));return
    }
    if(req.url==='/hitf/v2p/rest/invoke/employee'&&authorizationRetry) {authorizationRetry=false;res.statusCode=401;res.end('{}');return}
    if(!req.headers.authorization?.startsWith('Bearer fixture-')) {res.statusCode=401;res.end('{}');return}
    if(fail) {res.end(JSON.stringify({status:'fail',message:'fixture business error'}));return}
    const page=JSON.parse(text).page
    const records=req.url.endsWith('department')?departments:employees
    await pause(15)
    res.end(JSON.stringify({status:'S',page,size:2,totalElements:records.length,totalPages:Math.ceil(records.length/2),responseData:partial&&page===1?[]:records.slice(page*2,page*2+2)}))
  })
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve))
  const mdmPort=fixture.address().port
  const reservation=http.createServer()
  await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve))
  const appPort=reservation.address().port
  await new Promise(resolve=>reservation.close(resolve))
  let logs=''
  const child=spawn(process.execPath,['server/index.js'],{cwd:projectDir,windowsHide:true,env:{...process.env,STORAGE_DIR:storage,SERVER_PORT:String(appPort),ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'integration-admin',SESSION_SECRET:'integration-session',MOCK_AI:'true',MDM_API_BASE_URL:`http://127.0.0.1:${mdmPort}`,MDM_CLIENT_ID:'fixture-client',MDM_CLIENT_SECRET:'fixture-secret',PLATFORM_SCHEDULER_DISABLED:'true'}})
  child.stdout.on('data',data=>logs+=data)
  child.stderr.on('data',data=>logs+=data)
  t.after(async()=>{child.kill();await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve)});fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve))})
  const origin=`http://127.0.0.1:${appPort}`
  let ready=false
  for(let tries=0;tries<400;tries++){try{if((await fetch(`${origin}/api/health`)).ok){ready=true;break}}catch{}if(child.exitCode!==null)throw new Error(logs);await pause(50)}
  assert.ok(ready,`Fixture application did not become ready: ${logs}`)
  const admin={},employee={},otherEmployee={}
  async function request(url,{method='GET',body,client,expected=200}={}) {
    const response=await fetch(`${origin}${url}`,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(client?.cookie?{Cookie:client.cookie}:{})},body:body?JSON.stringify(body):undefined})
    const cookies=response.headers.getSetCookie()
    if(client&&cookies.length)client.cookie=cookies[0].split(';')[0]
    const data=await response.json()
    assert.equal(response.status,expected,`${method} ${url}: ${JSON.stringify(data)}`)
    return data
  }
  async function synchronize() {
    const started=await request('/api/admin/organization-sync',{method:'POST',client:admin,expected:202})
    for(let tries=0;tries<150;tries++){const status=await request('/api/admin/organization-sync',{client:admin});if(status.lastRun.id===started.id&&!status.running)return status.lastRun;await pause(30)}
    throw new Error('Fixture synchronization did not finish')
  }
  async function loginEmployee(account,client) {
    await request('/api/login',{method:'POST',body:{username:account,password:'123456'},client})
    await request('/api/account/password',{method:'POST',body:{currentPassword:'123456',password:'changed-fixture'},client})
  }

  await t.test('Guest restrictions and paginated MDM import',async()=>{
    await request('/api/admin/users',{expected:401})
    await request('/api/usage/qa',{method:'POST',expected:401})
    await request('/api/login',{method:'POST',body:{username:'admin',password:'integration-admin'},client:admin})
    const first=await synchronize()
    assert.equal(first.status,'completed')
    assert.equal(first.counts.added,6)
    assert.equal(first.counts.snapshot.captureStatus,'complete')
    const rawFolder=path.join(storage,'mdm-snapshots',first.id)
    const capture=JSON.parse(await fs.readFile(path.join(rawFolder,'manifest.json'),'utf8'))
    assert.equal(capture.captureStatus,'complete')
    assert.equal(capture.syncStatus,'completed')
    assert.ok(capture.responses.some(item=>item.kind==='employee'&&item.httpStatus===401))
    const departmentPage=JSON.parse(await fs.readFile(path.join(rawFolder,'department-page-0001.json'),'utf8'))
    assert.equal(departmentPage.responseData[1].parentDeptId,'company')
    assert.equal(departmentPage.responseData[1].companyId,'company')
    const employeePage=JSON.parse(await fs.readFile(path.join(rawFolder,'employee-page-0001-retry-01.json'),'utf8'))
    assert.equal(employeePage.responseData[0].deptId,'melt')
    assert.equal(employeePage.responseData[0].deptTopId,'p1')
    assert.ok(!JSON.stringify(capture).includes('fixture-secret'))
    assert.ok(!JSON.stringify(capture).includes('fixture-client'))
    assert.ok(capture.responses.every(item=>item.kind==='employee'||item.kind==='department'))
    assert.equal((await fs.readdir(path.join(storage,'backups'))).filter(name=>name.endsWith('.sqlite')).length,1)
    const directory=await request('/api/admin/departments',{client:admin})
    assert.equal(directory.totalEmployees,6)
    assert.equal(directory.companies.length,1)
    assert.equal(directory.items.find(item=>item.id==='melt').parentId,'p1')
    assert.equal(directory.items.find(item=>item.id==='p1').directCount,0)
    assert.equal(directory.items.find(item=>item.id==='p1').employeeCount,3)
    const users=await request('/api/admin/users?departmentId=p1&q=oa1001',{client:admin})
    assert.equal(users.total,1)
    assert.equal(users.items[0].departmentName,'熔炼车间')
    assert.equal(users.items[0].departmentPath,'总公司 / 制造一厂 / 熔炼车间')
    assert.equal((await request('/api/admin/users?departmentId=p1&includeDescendants=false',{client:admin})).total,0)
    assert.equal((await request('/api/admin/users?companyId=company',{client:admin})).total,6)
    assert.ok(!JSON.stringify(users).includes('password_hash'))
    assert.ok(tokenRequests>=2)
    assert.ok(requestedPaths.every(value=>['/oauth/oauth/token','/hitf/v2p/rest/invoke/department','/hitf/v2p/rest/invoke/employee'].includes(value)))
  })

  await t.test('Initial password, least privilege, multi-role grants and immediate revocation',async()=>{
    const me=await request('/api/login',{method:'POST',body:{username:'oa1001',password:'123456'},client:employee})
    assert.equal(me.mustChangePassword,true)
    await request('/api/usage/qa',{method:'POST',client:employee,expected:403})
    await request('/api/account/password',{method:'POST',body:{currentPassword:'123456',password:'changed-fixture'},client:employee})
    await request('/api/admin/users',{client:employee,expected:403})
    await request('/api/glossary-terms',{client:employee,expected:403})
    for(const role of ['glossary_admin','prompt_plant_1']) await request(`/api/admin/roles/${role}/members`,{method:'POST',body:{userIds:['mdm:e1']},client:admin})
    assert.equal((await request('/api/me',{client:employee})).isAdmin,true)
    await request('/api/glossary-terms',{method:'POST',body:{zhTerm:'测试术语',enTerm:'fixture term'},client:employee,expected:201})
    const prompts=await request('/api/admin/prompts',{client:employee})
    assert.deepEqual(prompts.items.map(item=>item.assistantId),['standard-plant-1'])
    await request('/api/admin/prompts/standard-plant-2',{method:'PUT',body:{prompt:'forbidden'},client:employee,expected:403})
    await request('/api/admin/prompts/standard-plant-1',{method:'PUT',body:{prompt:'fixture standard prompt'},client:employee})
    await request('/api/admin/roles/prompt_plant_1/members/mdm%3Ae1',{method:'DELETE',client:admin})
    await request('/api/admin/prompts',{client:employee,expected:403})
    await request('/api/admin/roles/super_admin/members/builtin%3Aadmin',{method:'DELETE',client:admin,expected:400})
  })

  await t.test('Usage idempotency and department snapshots survive personnel transfer',async()=>{
    const body={requestId:'unique-usage-request',departmentId:'p4',userId:'builtin:admin'}
    await request('/api/usage/qa',{method:'POST',body,client:employee})
    await request('/api/usage/qa',{method:'POST',body,client:employee})
    assert.equal((await request(`/api/stats?period=month&key=${month}&departmentId=p1`)).qaNativeUses,1)
    await loginEmployee('oa1002',otherEmployee)
    employees=employees.filter(item=>item.employeeId!=='e2').map(item=>item.employeeId==='e1'?{...item,name:'张明新姓名',deptId:'p2',deptTopId:'p2'}:item)
    assert.equal((await synchronize()).status,'completed')
    const updated=await request('/api/me',{client:employee})
    assert.equal(updated.departmentName,'制造二厂')
    assert.equal(updated.mustChangePassword,false)
    assert.ok(updated.roles.includes('glossary_admin'))
    assert.equal((await request('/api/me',{client:otherEmployee})).authenticated,false)
    await request('/api/usage/qa',{method:'POST',body:{requestId:'post-transfer-request'},client:employee})
    assert.equal((await request(`/api/stats?departmentId=p1&key=${month}`)).qaNativeUses,1)
    assert.equal((await request(`/api/stats?departmentId=p2&key=${month}`)).qaNativeUses,1)
    assert.equal((await request(`/api/stats?key=${previousMonth}`)).departments.find(item=>item.id==='legacy').qaNativeUses,1)
  })

  await t.test('Second and third plant editors can only maintain their assigned prompts',async()=>{
    for(const [account,id,plant] of [['oa1004','mdm:e4',2],['oa1003','mdm:e3',3]]) {
      const client={}
      await loginEmployee(account,client)
      await request(`/api/admin/roles/prompt_plant_${plant}/members`,{method:'POST',body:{userIds:[id]},client:admin})
      const prompts=await request('/api/admin/prompts',{client})
      assert.deepEqual(prompts.items.map(item=>item.assistantId),[`standard-plant-${plant}`])
      await request(`/api/admin/prompts/standard-plant-${plant}`,{method:'PUT',body:{prompt:`fixture plant ${plant}`},client})
      await request('/api/admin/prompts/standard-plant-1',{method:'PUT',body:{prompt:'forbidden'},client,expected:403})
      await request('/api/admin/model-audit',{client,expected:403})
    }
  })

  await t.test('Failed or incomplete synchronization preserves data, passwords and roles',async()=>{
    const before=await request('/api/admin/users',{client:admin})
    fail=true
    const failed=await synchronize()
    assert.equal(failed.status,'failed')
    assert.equal(failed.counts.snapshot.captureStatus,'incomplete')
    const failedPage=JSON.parse(await fs.readFile(path.join(storage,'mdm-snapshots',failed.id,'department-page-0001.json'),'utf8'))
    assert.equal(failedPage.status,'fail')
    fail=false;partial=true
    assert.equal((await synchronize()).status,'failed')
    partial=false
    assert.deepEqual(await request('/api/admin/users',{client:admin}),before)
    const another={}
    await request('/api/login',{method:'POST',body:{username:'oa1001',password:'changed-fixture'},client:another})
    assert.ok((await request('/api/me',{client:another})).roles.includes('glossary_admin'))
  })

  await t.test('Public feedback is newest-first with three per page and super-only replies',async()=>{
    for(let index=0;index<8;index++)await request('/api/feedback',{method:'POST',body:{content:`feedback-${index}`},client:employee})
    const page1=await request('/api/feedback')
    assert.equal(page1.items.length,3)
    assert.equal(page1.total,8)
    assert.equal(page1.items[0].content,'feedback-7')
    assert.equal((await request('/api/feedback?page=3')).items.length,2)
    await request(`/api/feedback/${page1.items[0].id}/reply`,{method:'PATCH',body:{reply:'forbidden'},client:employee,expected:403})
    await request(`/api/feedback/${page1.items[0].id}/reply`,{method:'PATCH',body:{reply:'fixture reply'},client:admin})
    assert.equal((await request('/api/feedback')).items[0].reply,'fixture reply')
  })

  await t.test('Dirty full-page snapshots import valid people and defer deactivation',async()=>{
    const original=employees
    const primary=original.find(item=>item.employeeId==='e1')
    employees=[
      ...original.filter(item=>item.employeeId!=='e3'),
      {...primary,employeeId:'conflicting-person'},
      {employeeId:'no-code',name:'无工号'},
      {employeeId:'new-person',code:'new-account',deptTopId:'p1'},
    ]
    const result=await synchronize()
    assert.equal(result.status,'completed')
    assert.equal(result.counts.deactivationDeferred,true)
    assert.equal(result.counts.diagnostics.missingAccount,1)
    assert.equal(result.counts.diagnostics.conflictingAccounts,1)
    assert.ok(result.counts.diagnostics.skippedRecords>=3)
    const current=await request('/api/me',{client:employee})
    assert.equal(current.name,'张明新姓名')
    assert.ok(current.roles.includes('glossary_admin'))
    assert.equal((await request('/api/admin/users?q=oa1003',{client:admin})).total,1)
    assert.equal((await request('/api/admin/users?q=new-account',{client:admin})).items[0].name,'new-account')
    const journal=await fs.readFile(path.join(storage,'logs','mdm-sync.log'),'utf8')
    assert.ok(journal.includes('"event":"validated"'))
    assert.ok(journal.includes('"missingAccount":1'))
    assert.ok(!journal.includes('fixture-secret'))
    employees=original
  })

  await t.test('Password reset invalidates old sessions; assistant streaming remains available',async()=>{
    const stream=await fetch(`${origin}/api/ragflow/chat/stream`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:employee.cookie},body:JSON.stringify({question:'fixture question'})})
    assert.equal(stream.status,200)
    assert.ok((await stream.text()).includes('"type":"done"'))
    await request('/api/admin/users/mdm%3Ae1/reset-password',{method:'POST',client:admin})
    assert.equal((await request('/api/me',{client:employee})).authenticated,false)
    assert.equal((await request('/api/login',{method:'POST',body:{username:'oa1001',password:'123456'},client:employee})).mustChangePassword,true)
  })
  assert.ok(!logs.includes('fixture-secret'))
})

function currentMonth(){return shanghaiDate().slice(0,7)}

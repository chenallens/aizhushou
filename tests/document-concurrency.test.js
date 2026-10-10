import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import initSqlJs from 'sql.js'
import {Document,Packer,Paragraph,Table,TableRow,TableCell} from 'docx'
import mammoth from 'mammoth'
import {parse} from 'node-html-parser'

const project=process.env.CONCURRENCY_TEST_APP_DIR||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const nodeExecutable=process.env.CONCURRENCY_TEST_NODE||process.execPath
function deferred(){let resolve;return {promise:new Promise(done=>resolve=done),resolve:()=>resolve()}}
async function until(check){for(let tries=0;tries<800;tries++){if(await check())return;await pause(10)}throw new Error('Fixture condition did not become true')}

test('Document concurrency, queues, retries and super-admin configuration integrate end to end',{timeout:90000},async(t)=>{
  const storage=await fs.mkdtemp(path.join(os.tmpdir(),'aizhushou-concurrent-')),SQL=await initSqlJs(),db=new SQL.Database()
  db.run('CREATE TABLE users(id TEXT PRIMARY KEY,employee_id TEXT UNIQUE,username TEXT UNIQUE,name TEXT,department_id TEXT,company_id TEXT,password_hash TEXT,must_change_password INTEGER DEFAULT 0,auth_version INTEGER DEFAULT 1,builtin INTEGER DEFAULT 0,active INTEGER DEFAULT 1,created_at TEXT,updated_at TEXT); CREATE TABLE user_roles(user_id TEXT,role_id TEXT,created_at TEXT,PRIMARY KEY(user_id,role_id));')
  const hash='concurrent-salt:'+crypto.scryptSync('employee-test-password','concurrent-salt',32).toString('hex')
  for(const id of ['ordinary','terms'])db.run('INSERT INTO users(id,employee_id,username,name,password_hash,created_at,updated_at)VALUES(?,?,?,?,?,?,?)',[id,id,id,'测试'+id,hash,'old','old'])
  db.run("INSERT INTO user_roles VALUES('terms','glossary_admin','old')")
  await fs.writeFile(path.join(storage,'aizhushou.sqlite'),Buffer.from(db.export()));db.close()
  const children=[]
  for(let index=1;index<=3;index++)children.push(new Paragraph('FRAGMENT_'+index+' '+'Original inspection instruction. '.repeat(180)),new Table({rows:[
    new TableRow({children:[new TableCell({children:[new Paragraph('Item')]}),new TableCell({children:[new Paragraph('Value')]})]}),
    new TableRow({children:[new TableCell({children:[new Paragraph('Row '+index)]}),new TableCell({children:[new Paragraph(index+' MPa')]})]}),
  ]}))
  const word=await Packer.toBuffer(new Document({sections:[{children}]}))
  const output=index=>'# Translation '+index+'\n\nTRANSLATED_FRAGMENT_'+index+' '+'Translated inspection text. '.repeat(230)+'\n\n| Item | Value |\n| --- | --- |\n| Row '+index+' | '+index+' MPa |'
  const records=[],gate=deferred(),specificGates=new Map()
  let mode='transient',gateFirst=true,active=0,peak=0,polishFailed=false,layoutFailed=false
  const model=http.createServer(async(req,res)=>{
    const pieces=[];for await(const piece of req)pieces.push(piece)
    const body=JSON.parse(Buffer.concat(pieces).toString()),first=body.messages[0].content,last=body.messages.at(-1).content
    const kind=first.includes('文档排版检查员')?'layout':first.includes('术语校订')?'polish':first.includes('双语翻译质检员')?'quality':'direct'
    const index=Number(last.match(/(?:TRANSLATED_)?FRAGMENT_([123])/)?.[1]||0),record={kind,index,body,status:200}
    records.push(record);active++;peak=Math.max(peak,active)
    let settled=false;const settle=()=>{if(!settled){settled=true;active--}}
    res.once('close',settle)
    try {
      if(kind==='direct'&&gateFirst)await gate.promise
      if(kind==='direct'&&specificGates.has(index))await specificGates.get(index).promise
      await pause(mode==='fatal'?(index===1?15:120):(index===1?65:15))
      if(res.destroyed)return
      if(mode==='fatal'&&kind==='direct'&&index===1)record.status=401
      if(mode==='layout-fail'&&kind==='layout'&&index===2)record.status=503
      if(mode==='transient'&&kind==='polish'&&index===2&&!polishFailed){polishFailed=true;record.status=503}
      if(mode==='transient'&&kind==='layout'&&index===2&&!layoutFailed){layoutFailed=true;record.status=503}
      res.writeHead(record.status,{'Content-Type':'application/json'})
      const content=kind==='layout'?last.split('待排版内容：\n').slice(1).join('待排版内容：\n'):output(index)
      res.end(JSON.stringify(record.status===200?{choices:[{message:{content}}]}:{error:'fixture '+record.status}))
    }finally{settle()}
  })
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve))
  const reserve=http.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve))
  let child,logs=''
  const env={...process.env,SERVER_PORT:String(port),STORAGE_DIR:storage,MOCK_AI:'false',ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'concurrency-test-admin',SESSION_SECRET:'concurrency-test-session',PLATFORM_SCHEDULER_DISABLED:'true',AI_MODEL_API_URL:'http://127.0.0.1:'+model.address().port+'/model',AI_MODEL_NAME:'fixture',TRANSLATION_CHUNK_CONCURRENCY:'2',DOCUMENT_LAYOUT_CONCURRENCY:'2',AI_DOCUMENT_MAX_CONCURRENCY:'2',AI_DOCUMENT_RETRY_COUNT:'1',AI_DOCUMENT_RETRY_DELAY_MS:'20'}
  const origin='http://127.0.0.1:'+port
  async function start(){child=spawn(nodeExecutable,['server/index.js'],{cwd:project,windowsHide:true,env});child.stdout.on('data',piece=>logs+=piece);child.stderr.on('data',piece=>logs+=piece);await until(async()=>{if(child.exitCode!==null)throw new Error(logs);try{return(await fetch(origin+'/api/health')).ok}catch{return false}})}
  async function stop(){if(child&&child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve))}}
  t.after(async()=>{gate.resolve();for(const hold of specificGates.values())hold.resolve();await stop();model.closeAllConnections();await new Promise(resolve=>model.close(resolve))})
  await start()
  const login=async(username,password)=>{const response=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});assert.equal(response.status,200);return response.headers.getSetCookie()[0].split(';')[0]}
  const admin=await login('admin','concurrency-test-admin'),ordinary=await login('ordinary','employee-test-password'),terms=await login('terms','employee-test-password')
  async function api(url,{cookie=admin,method='GET',body,expected=200}={}){const response=await fetch(origin+url,{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));return data}
  async function upload(){const form=new FormData();form.append('file',new Blob([word]),'concurrent.docx');form.append('libraryIds','["general","testing"]');const response=await fetch(origin+'/api/translate/document',{method:'POST',headers:{Cookie:admin},body:form});assert.equal(response.status,202);return(await response.json()).task}
  const task=async(id)=>(await api('/api/document-tasks/'+id)).task
  async function finish(id,progress=[]){let result;await until(async()=>{result=await task(id);progress.push(result.progress);return['completed','failed'].includes(result.status)});return result}
  const setting=(body)=>api('/api/admin/document-concurrency',{method:'PUT',body})
  const term=(await api('/api/glossary-terms',{method:'POST',body:{zhTerm:'并发测试',enTerm:'FROZEN_TERM'},expected:201})).item

  await t.test('Two files share two requests, later submitter is notified and result order survives retries',async()=>{
    const first=await upload();await until(()=>records.filter(item=>item.kind==='direct').length===2)
    const second=await upload();assert.equal(second.metadata.queueWaiting,true);assert.ok(second.metadata.queueNotice.includes('请勿重复提交'))
    await until(async()=>Boolean((await task(second.id)).metadata.queueWaiting))
    const waiting=await task(second.id);assert.equal(waiting.metadata.parallel.limit,2);assert.equal(waiting.metadata.parallel.items.filter(item=>item.status==='queued').length,2)
    await api('/api/glossary-terms/'+term.id,{method:'PATCH',body:{zhTerm:term.zhTerm,enTerm:'UPDATED_TERM'}})
    gateFirst=false;gate.resolve()
    const p1=[],p2=[],results=await Promise.all([finish(first.id,p1),finish(second.id,p2)])
    assert.equal(peak,2);for(const values of [p1,p2])assert.deepEqual([...values].sort((a,b)=>a-b),values)
    for(const value of results){
      assert.equal(value.status,'completed',value.error);assert.equal(value.metadata.totalChunks,3);assert.equal(value.metadata.translationConcurrency,2);assert.equal(value.metadata.layoutModel.concurrency,2)
      assert.equal(value.metadata.layout.tables,3);assert.equal(value.metadata.queueWaiting,undefined)
      const html=parse(value.previewHtml),text=html.structuredText
      assert.ok(text.indexOf('TRANSLATED_FRAGMENT_1')<text.indexOf('TRANSLATED_FRAGMENT_2'));assert.ok(text.indexOf('TRANSLATED_FRAGMENT_2')<text.indexOf('TRANSLATED_FRAGMENT_3'))
      const response=await fetch(origin+value.downloadUrl,{headers:{Cookie:admin}}),native=parse((await mammoth.convertToHtml({buffer:Buffer.from(await response.arrayBuffer())})).value)
      assert.equal(native.querySelectorAll('table').length,3)
    }
    assert.equal(records.filter(item=>item.kind==='direct').length,6);assert.equal(records.filter(item=>item.kind==='polish').length,7);assert.equal(records.filter(item=>item.kind==='quality').length,6)
    assert.equal(results.reduce((sum,item)=>sum+item.metadata.modelRetries,0),2)
    for(const item of records.filter(item=>['polish','quality'].includes(item.kind))){const text=JSON.stringify(item.body.messages);assert.ok(text.includes('FROZEN_TERM'));assert.ok(!text.includes('UPDATED_TERM'))}
    const log=(await fs.readFile(path.join(storage,'logs','document-concurrency.log'),'utf8')).trim().split('\n').map(line=>JSON.parse(line))
    assert.ok(log.some(item=>item.event==='retry'));assert.ok(log.some(item=>item.purpose.includes(first.id)));assert.ok(!JSON.stringify(log).includes('Original inspection'))
  })
  await t.test('Only super admins can edit, invalid settings are rejected and lowering the limit does not cancel work',async()=>{
    await api('/api/admin/document-concurrency',{cookie:'',expected:401})
    for(const cookie of [ordinary,terms]){
      await api('/api/admin/document-concurrency',{cookie,expected:403})
      await api('/api/admin/document-concurrency',{cookie,method:'PUT',body:{translation:1,layout:1,requests:1,retries:0},expected:403})
    }
    for(const body of [{translation:0,layout:2,requests:2,retries:1},{translation:2,layout:2,requests:9,retries:1},{translation:'2',layout:2,requests:2,retries:1},{translation:2,layout:2,requests:2,retries:1,unexpected:1}])await api('/api/admin/document-concurrency',{method:'PUT',body,expected:400})
    mode='normal';records.length=0;specificGates.set(1,deferred());specificGates.set(2,deferred())
    const accepted=await upload();await until(()=>records.length===2)
    const changed=await setting({translation:1,layout:1,requests:1,retries:1});assert.equal(changed.state.active,2);assert.equal(changed.state.limit,1)
    specificGates.get(1).resolve();await until(()=>active===1);await pause(80);assert.equal(records.length,2)
    specificGates.get(2).resolve();specificGates.clear()
    const done=await finish(accepted.id);assert.equal(done.status,'completed',done.error)
    records.length=0;peak=0
    const serial=await upload(),serialDone=await finish(serial.id);assert.equal(serialDone.status,'completed');assert.equal(serialDone.metadata.translationConcurrency,1);assert.equal(serialDone.metadata.layoutModel.concurrency,1);assert.equal(peak,1)
    await stop();await start()
    const loaded=await api('/api/admin/document-concurrency');assert.deepEqual(loaded.settings,{translation:1,layout:1,requests:1,retries:1});assert.equal(loaded.state.limit,1);assert.ok(loaded.updatedAt)
    assert.ok((await api('/api/admin/operations')).items.some(item=>item.action==='document_concurrency.update'))
  })
  await t.test('Fatal errors are not retried, peers stop, and exhausted layout retries safely retain the source',async()=>{
    await setting({translation:2,layout:2,requests:2,retries:1});mode='fatal';records.length=0
    const accepted=await upload(),failed=await finish(accepted.id);assert.equal(failed.status,'failed');assert.equal(failed.downloadUrl,null)
    assert.equal(records.filter(item=>item.kind==='direct'&&item.index===1).length,1);assert.ok(!records.some(item=>item.index===3))
    const saved=JSON.stringify(failed);await pause(160);assert.equal(JSON.stringify(await task(accepted.id)),saved)
    mode='layout-fail';records.length=0
    const next=await upload(),done=await finish(next.id);assert.equal(done.status,'completed',done.error);assert.equal(done.metadata.layout.tables,3);assert.ok(done.metadata.layoutModel.warnings.length>0);assert.ok(done.metadata.modelRetries>=1)
    assert.equal(records.filter(item=>item.kind==='layout'&&item.index===2).length,2)
  })
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import mammoth from 'mammoth'
import {parse} from 'node-html-parser'

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
function barrier(){let started,release;return {entered:new Promise(resolve=>started=resolve),wait:new Promise(resolve=>release=resolve),started:()=>started(),release:()=>release()}}
test('PDF translation preserves original-language recognition, selected terminology and document structure',{timeout:60000},async(t)=>{
  const storage=await fs.mkdtemp(path.join(os.tmpdir(),'aizhushou-pdf-translation-')),calls=[],holds=new Map()
  let failOcr=false
  const textSource='# TEXT_PAGE\n\n| Requirement | Value |\n| --- | --- |\n| Text inspection | 5 MPa |'
  const imageSource='## IMAGE_PAGE\n\nImage inspection requires a minimum pressure of 7 MPa.'
  const translated='# 译文检查单\n\n| 要求 | 数值 |\n| --- | --- |\n| 文本检查 | 5 MPa |\n| 图像检查 | 7 MPa |'
  const model=http.createServer(async(req,res)=>{
    const pieces=[];for await(const piece of req)pieces.push(piece)
    const body=JSON.parse(Buffer.concat(pieces).toString()),first=body.messages[0].content
    const kind=Array.isArray(first)?'ocr':first.includes('PDF 文档识别')?'recognize':first.includes('文档排版检查员')?'layout':first.includes('术语校订')?'polish':first.includes('双语翻译质检员')?'quality':'direct'
    calls.push({kind,body})
    const hold=holds.get(kind);if(hold){hold.started();await hold.wait;holds.delete(kind)}
    if(kind==='ocr'&&failOcr){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'fixture OCR unavailable'}));return}
    const content=kind==='recognize'?textSource:kind==='ocr'?imageSource:kind==='layout'?body.messages.at(-1).content.split('待排版内容：\n').slice(1).join('待排版内容：\n'):translated
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content}}]}))
  })
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve))
  const reserve=http.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve))
  const child=spawn(process.execPath,['server/index.js'],{cwd:project,windowsHide:true,env:{...process.env,SERVER_PORT:String(port),STORAGE_DIR:storage,MOCK_AI:'false',ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'pdf-test-password',SESSION_SECRET:'pdf-test-session',PLATFORM_SCHEDULER_DISABLED:'true',AI_MODEL_API_URL:'http://127.0.0.1:'+model.address().port+'/model',AI_MODEL_NAME:'fixture'}})
  let logs='';child.stdout.on('data',piece=>logs+=piece);child.stderr.on('data',piece=>logs+=piece)
  t.after(async()=>{for(const hold of holds.values())hold.release();child.kill();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));model.closeAllConnections();await new Promise(resolve=>model.close(resolve))})
  const origin='http://127.0.0.1:'+port
  let healthy=false;for(let tries=0;tries<300;tries++){try{if((await fetch(origin+'/api/health')).ok){healthy=true;break}}catch{}if(child.exitCode!==null)throw new Error(logs);await pause(50)}assert.ok(healthy)
  const login=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'pdf-test-password'})});assert.equal(login.status,200)
  const cookie=login.headers.getSetCookie()[0].split(';')[0],headers={Cookie:cookie}
  const json=async(url,body,method='POST')=>{const response=await fetch(origin+url,{method,headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(response.ok);return response.json()}
  const uploaded=async(bytes,name,fields={})=>{const form=new FormData();form.append('file',new Blob([bytes]),name);for(const[key,value]of Object.entries(fields))form.append(key,value);const response=await fetch(origin+'/api/translate/document',{method:'POST',headers,body:form});return {status:response.status,data:await response.json()}}
  const task=async(id)=>(await(await fetch(origin+'/api/document-tasks/'+id,{headers})).json()).task
  async function finish(id){for(let tries=0;tries<300;tries++){const value=await task(id);if(['completed','failed'].includes(value.status))return value;await pause(30)}throw new Error('Document task did not finish')}
  const general=(await json('/api/glossary-terms',{zhTerm:'通用测试',enTerm:'PDF_GENERAL_ORIGINAL'})).item
  const testing=(await json('/api/glossary-terms',{libraryId:'testing',zhTerm:'理化测试',enTerm:'PDF_TESTING_ORIGINAL'})).item
  const fixture=await fs.readFile(path.join(project,'tests','fixtures','translation-mixed.pdf'))

  await t.test('PDF recognition precedes translation; progress is monotonic and snapshots stay fixed',async()=>{
    for(const kind of ['ocr','direct','polish','quality','layout'])holds.set(kind,barrier())
    const pending=new Map(holds),accepted=await uploaded(fixture,'翻译测试.PDF',{direction:'en-zh',libraryIds:'["general","testing"]'})
    assert.equal(accepted.status,202);assert.equal(accepted.data.task.metadata.sourceFormat,'pdf')
    const id=accepted.data.task.id,progress=[]
    await pending.get('ocr').entered
    let value=await task(id);progress.push(value.progress);assert.equal(value.metadata.phase,'recognizing');assert.equal(value.metadata.totalPages,2);assert.equal(value.metadata.completedPages,1);assert.ok(value.stage.includes('图像识别'))
    assert.deepEqual(await fs.readdir(path.join(storage,'results')),[])
    await json('/api/glossary-terms/'+general.id,{zhTerm:general.zhTerm,enTerm:'PDF_GENERAL_UPDATED'},'PATCH')
    await json('/api/glossary-terms/'+testing.id,{libraryId:'testing',zhTerm:testing.zhTerm,enTerm:'PDF_TESTING_UPDATED'},'PATCH')
    pending.get('ocr').release()
    for(const kind of ['direct','polish','quality','layout']){
      await pending.get(kind).entered;value=await task(id);progress.push(value.progress)
      assert.equal(value.metadata.phase,kind==='layout'?'layout-model':'processing')
      if(kind==='direct'){assert.equal(value.metadata.completedPages,2);assert.equal(value.progress,32);assert.equal(value.metadata.sourceFormat,'pdf')}
      pending.get(kind).release()
    }
    value=await finish(id);assert.equal(value.status,'completed',value.error);assert.equal(value.progress,100);progress.push(value.progress)
    assert.deepEqual([...progress].sort((a,b)=>a-b),progress)
    assert.deepEqual(value.metadata.libraryIds,['general','testing']);assert.equal(value.metadata.totalPages,2);assert.deepEqual(value.metadata.recognition,{textPages:1,imagePages:1})
    assert.equal(value.metadata.modelCalls,6);assert.equal(value.metadata.layout.tables,1);assert.equal(value.metadata.formattedResult,true);assert.ok(value.markdownDownloadUrl)
    assert.deepEqual(calls.map(call=>call.kind),['recognize','ocr','direct','polish','quality','layout'])
    assert.ok(calls[0].body.messages[0].content.includes('保留原文语言'))
    const ocr=calls[1].body.messages[0].content;assert.ok(ocr[0].text.includes('不进行翻译'));assert.ok(ocr[1].image_url.url.startsWith('data:image/png;base64,'));assert.ok(ocr[1].image_url.url.length>1000)
    const direct=JSON.stringify(calls[2].body.messages);assert.ok(direct.includes('TEXT_PAGE'));assert.ok(direct.includes('IMAGE_PAGE'));assert.ok(!direct.includes('PDF_GENERAL_ORIGINAL'))
    for(const call of calls.slice(3,5)){const content=JSON.stringify(call.body.messages);assert.ok(content.includes('PDF_GENERAL_ORIGINAL'));assert.ok(content.includes('PDF_TESTING_ORIGINAL'));assert.ok(!content.includes('PDF_GENERAL_UPDATED'));assert.ok(!content.includes('PDF_TESTING_UPDATED'))}
    const download=await fetch(origin+value.downloadUrl,{headers});assert.equal(download.status,200);assert.ok(decodeURIComponent(download.headers.get('Content-Disposition')).includes('翻译测试-翻译.docx'))
    const document=parse((await mammoth.convertToHtml({buffer:Buffer.from(await download.arrayBuffer())})).value);assert.equal(document.querySelectorAll('table').length,1);assert.ok(document.structuredText.includes('文本检查'));assert.ok(document.structuredText.includes('7 MPa'))
    const markdown=await fetch(origin+value.markdownDownloadUrl,{headers});const raw=await mammoth.extractRawText({buffer:Buffer.from(await markdown.arrayBuffer())});assert.ok(raw.value.includes('| 文本检查 | 5 MPa |'))
    assert.equal((await fetch(origin+value.downloadUrl)).status,401)
    assert.deepEqual(await fs.readFile(path.join(project,'tests','fixtures','translation-mixed.pdf')),fixture)
  })
  await t.test('Unsupported files are rejected and malformed PDF fails without invoking translation',async()=>{
    calls.length=0
    for(const name of ['not-supported.xlsx','old-format.doc']){const rejected=await uploaded(Buffer.from('fixture'),name);assert.equal(rejected.status,400);assert.ok(rejected.data.error.includes('DOCX 和 PDF'))}
    const broken=await uploaded(Buffer.from('%PDF-1.7\nbroken fixture'),'broken.pdf');assert.equal(broken.status,202)
    const failed=await finish(broken.data.task.id);assert.equal(failed.status,'failed');assert.ok(failed.error);assert.equal(calls.length,0)
    assert.ok((await fetch(origin+'/api/health')).ok)
  })
  await t.test('OCR failure stops the task; another PDF task can complete afterwards',async()=>{
    calls.length=0;failOcr=true
    const accepted=await uploaded(fixture,'ocr-failure.pdf');assert.equal(accepted.status,202)
    const failed=await finish(accepted.data.task.id);assert.equal(failed.status,'failed');assert.equal(failed.downloadUrl,null);assert.ok(calls.some(call=>call.kind==='ocr'));assert.ok(!calls.some(call=>call.kind==='direct'))
    failOcr=false;calls.length=0
    const recovered=await uploaded(await fs.readFile(path.join(project,'tests','fixtures','layout-source.pdf')),'text-only.pdf',{direction:'zh-en'})
    const done=await finish(recovered.data.task.id);assert.equal(done.status,'completed',done.error);assert.equal(done.metadata.totalPages,1);assert.deepEqual(done.metadata.recognition,{textPages:1,imagePages:0});assert.ok(JSON.stringify(calls.find(call=>call.kind==='direct').body.messages).includes('中文翻译为英文'))
  })
})

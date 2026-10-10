import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {Document,Packer,Paragraph,Table,TableRow,TableCell,TextRun} from 'docx'
import mammoth from 'mammoth'
import {parse} from 'node-html-parser'

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
test('Library APIs, authenticated PDF, model references and Word snapshots integrate end to end',async(t)=>{
  const storage=await fs.mkdtemp(path.join(os.tmpdir(),'aizhushou-libraries-'))
  const calls=[];let hold=null,tableMode=false,tamperLayout=false
  const tableOutput='# 翻译检查单\n\n| 项目 | 要求 | 备注 |\n| --- | --- | --- |\n| 压力 | ≥ 5 MPa<br>复验 | |\n| A\\|B | C:\\\\Audit\\\\2026 | 1.2 |'
  const model=http.createServer(async(req,res)=>{
    const parts=[];for await(const chunk of req)parts.push(chunk)
    const body=JSON.parse(Buffer.concat(parts).toString());calls.push(body)
    if(hold&&calls.length===hold.position){hold.started();await hold.promise}
    const layout=body.messages[0]?.content.includes('你是文档排版检查员')
    const source=layout?body.messages.at(-1).content.split('待排版内容：\n').slice(1).join('待排版内容：\n'):''
    const content=layout?(tamperLayout?source.replace('5 MPa','50 MPa'):source):(tableMode?tableOutput:body.stream?'最终译文':'修订译文')
    if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\n');res.end('data: [DONE]\n\n')}
    else {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content}}]}))}
  })
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve))
  const reservation=http.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve))
  let logs=''
  const child=spawn(process.execPath,['server/index.js'],{cwd:project,windowsHide:true,env:{...process.env,SERVER_PORT:String(port),STORAGE_DIR:storage,MOCK_AI:'false',ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'library-admin',SESSION_SECRET:'library-session',AI_MODEL_API_URL:`http://127.0.0.1:${model.address().port}/model`,AI_MODEL_NAME:'fixture',PLATFORM_SCHEDULER_DISABLED:'true'}})
  child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk)
  t.after(async()=>{hold?.release();child.kill();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));model.closeAllConnections();await new Promise(resolve=>model.close(resolve))})
  const origin=`http://127.0.0.1:${port}`
  for(let tries=0;tries<300;tries++){try{if((await fetch(origin+'/api/health')).ok)break}catch{}if(child.exitCode!==null)throw new Error(logs);await pause(50)}
  let cookie=''
  async function api(url,method='GET',body,expected=200){const response=await fetch(origin+url,{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const cookies=response.headers.getSetCookie();if(cookies.length)cookie=cookies[0].split(';')[0];const data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));return data}
  const guest=await fetch(origin+'/api/translation/terminology-source.pdf');assert.equal(guest.status,401)
  await api('/api/login','POST',{username:'admin',password:'library-admin'})
  const range=await fetch(origin+'/api/translation/terminology-source.pdf',{headers:{Cookie:cookie,Range:'bytes=0-31'}})
  assert.equal(range.status,206);assert.equal(range.headers.get('Content-Type'),'application/pdf');assert.ok(range.headers.get('Content-Disposition').startsWith('inline'));assert.equal((await range.arrayBuffer()).byteLength,32)
  assert.equal((await api('/api/glossary-libraries')).items.length,4)
  const general=(await api('/api/glossary-terms','POST',{zhTerm:'通用唯一标识',enTerm:'GENERAL_SENTINEL'},201)).item
  const testing=(await api('/api/glossary-terms','POST',{libraryId:'testing',zhTerm:'理化唯一标识',enTerm:'TESTING_SENTINEL'},201)).item
  const duplicate=await api('/api/glossary-terms','POST',{libraryId:'testing',zhTerm:'另一个中文',enTerm:'testing_sentinel'})
  assert.equal(duplicate.requiresConfirmation,true);assert.equal(duplicate.conflicts[0].existing.zhTerm,testing.zhTerm);assert.equal(duplicate.conflicts[0].existing.enTerm,testing.enTerm)
  assert.equal((await api('/api/glossary-terms?libraryId=testing')).total,1)
  const override=await api('/api/glossary-terms','POST',{libraryId:'testing',zhTerm:'另一个中文',enTerm:'testing_sentinel',allowDuplicates:true},201)
  assert.notEqual(override.item.id,testing.id)
  const text=body=>JSON.stringify(body.messages)
  async function chat(libraryId){calls.length=0;const response=await fetch(origin+'/api/translate/chat/stream',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({text:'The sample shall be inspected.',...(libraryId?{libraryId}:{})})});assert.equal(response.status,200);const stream=await response.text();assert.ok(stream.includes('"type":"done"'));assert.ok(!stream.includes('glossaryCount'));assert.equal(calls.length,3);return stream}
  await chat('testing');assert.ok(!text(calls[0]).includes('TESTING_SENTINEL'));for(const call of calls.slice(1)){assert.ok(text(call).includes('TESTING_SENTINEL'));assert.ok(!text(call).includes('GENERAL_SENTINEL'))}
  await chat();for(const call of calls.slice(1)){assert.ok(text(call).includes('GENERAL_SENTINEL'));assert.ok(!text(call).includes('TESTING_SENTINEL'))}
  calls.length=0
  const multiple=await fetch(origin+'/api/translate/chat/stream',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({text:'The sample shall be inspected.',libraryIds:['testing','general']})})
  const multipleStream=await multiple.text();assert.equal(multiple.status,200);assert.ok(multipleStream.includes('"libraryIds":["general","testing"]'));assert.equal(calls.length,3)
  assert.ok(!text(calls[0]).includes('GENERAL_SENTINEL'));for(const call of calls.slice(1)){assert.ok(text(call).includes('GENERAL_SENTINEL'));assert.ok(text(call).includes('TESTING_SENTINEL'))}
  await api('/api/translate/chat/stream','POST',{text:'x',libraryIds:['invalid']},400)
  await api('/api/translate/chat/stream','POST',{text:'x',libraryId:'invalid'},400)
  calls.length=0
  let signal;const started=new Promise(resolve=>signal=resolve);let release;const promise=new Promise(resolve=>release=resolve);hold={position:1,promise,release,started:signal}
  const bytes=await Packer.toBuffer(new Document({sections:[{children:[new Paragraph('Test document for terminology snapshot.')]}]}))
  const form=new FormData();form.append('file',new Blob([bytes]),'snapshot.docx');form.append('libraryIds','["general","testing"]')
  const response=await fetch(origin+'/api/translate/document',{method:'POST',headers:{Cookie:cookie},body:form});assert.equal(response.status,202);const task=(await response.json()).task
  assert.deepEqual(task.metadata.libraryIds,['general','testing'])
  await started
  await api(`/api/glossary-terms/${testing.id}`,'PATCH',{libraryId:'testing',zhTerm:testing.zhTerm,enTerm:'UPDATED_REFERENCE'})
  await api(`/api/glossary-terms/${override.item.id}?libraryId=testing`,'DELETE')
  hold.release();hold=null
  let result
  for(let tries=0;tries<200;tries++){result=(await api('/api/document-tasks/'+task.id)).task;if(result.status==='completed')break;if(result.status==='failed')throw new Error(result.error);await pause(50)}
  assert.equal(result.status,'completed');assert.deepEqual(result.metadata.libraryIds,['general','testing']);assert.equal(result.metadata.glossaryCount,undefined)
  for(const call of calls.slice(1,3)){assert.ok(text(call).includes('TESTING_SENTINEL'));assert.ok(!text(call).includes('UPDATED_REFERENCE'));assert.ok(text(call).includes('GENERAL_SENTINEL'))}
  assert.equal(calls.length,4);assert.equal(result.metadata.phase,'completed');assert.equal(result.metadata.formattedResult,true);assert.ok(result.markdownDownloadUrl)
  const downloaded=await fetch(origin+result.downloadUrl,{headers:{Cookie:cookie}});assert.equal(downloaded.status,200);assert.ok((await downloaded.arrayBuffer()).byteLength>1000)
  await api('/api/glossary-terms/batch','POST',{action:'delete',libraryId:'processing',ids:[general.id]},404)
  assert.equal((await api('/api/glossary-terms')).items[0].id,general.id)
  tableMode=true;tamperLayout=true;calls.length=0
  const tableBytes=await Packer.toBuffer(new Document({sections:[{children:[new Paragraph('TABLE_INPUT'),new Table({rows:[
    new TableRow({children:[new TableCell({children:[new Paragraph('Test | header')]}),new TableCell({children:[new Paragraph('Path')]}),new TableCell({children:[new Paragraph('Blank')]} )]}),
    new TableRow({children:[new TableCell({children:[new Paragraph('A|B')]}),new TableCell({children:[new Paragraph('C:\\Audit\\2026')]}),new TableCell({children:[new Paragraph('')]} )]}),
    new TableRow({children:[new TableCell({children:[new Paragraph({children:[new TextRun('First line'),new TextRun({text:'Second line',break:1})]})]}),new TableCell({children:[new Paragraph('Third')]}),new TableCell({children:[new Paragraph('')]} )]}),
  ]})]}]}))
  const tableForm=new FormData();tableForm.append('file',new Blob([tableBytes]),'table.docx');tableForm.append('libraryIds','["general","testing"]')
  const accepted=await fetch(origin+'/api/translate/document',{method:'POST',headers:{Cookie:cookie},body:tableForm});assert.equal(accepted.status,202);const tableTask=(await accepted.json()).task
  for(let tries=0;tries<300;tries++){result=(await api('/api/document-tasks/'+tableTask.id)).task;if(['completed','failed'].includes(result.status))break;await pause(30)}
  assert.equal(result.status,'completed',result.error);assert.equal(result.metadata.layout.tables,1);assert.equal(result.metadata.modelCalls,4);assert.ok(result.metadata.layoutModel.warnings.length>0)
  const sourceInput=calls[0].messages.at(-1).content
  assert.ok(sourceInput.includes('Test \\| header'),sourceInput);assert.ok(sourceInput.includes('A\\|B'));assert.ok(sourceInput.includes('C:\\\\Audit\\\\2026'));assert.ok(sourceInput.includes('First line<br>Second line'))
  const preview=parse(result.previewHtml);assert.equal(preview.querySelectorAll('table').length,1);assert.ok(preview.structuredText.includes('5 MPa'));assert.ok(!preview.structuredText.includes('50 MPa'))
  const formattedBytes=Buffer.from(await(await fetch(origin+result.downloadUrl,{headers:{Cookie:cookie}})).arrayBuffer())
  const restored=parse((await mammoth.convertToHtml({buffer:formattedBytes})).value);assert.equal(restored.querySelectorAll('table').length,1);assert.ok(restored.structuredText.includes('5 MPa'))
  const markdownBytes=Buffer.from(await(await fetch(origin+result.markdownDownloadUrl,{headers:{Cookie:cookie}})).arrayBuffer())
  const raw=await mammoth.extractRawText({buffer:markdownBytes});assert.ok(raw.value.includes('| 项目 | 要求 | 备注 |'));assert.equal(parse((await mammoth.convertToHtml({buffer:markdownBytes})).value).querySelectorAll('table').length,0)
  await api('/api/document-tasks/'+tableTask.id+'/download?format=invalid','GET',undefined,400)
  calls.length=0
  const pdfForm=new FormData();pdfForm.append('file',new Blob([await fs.readFile(path.join(project,'tests','fixtures','layout-source.pdf'))]),'layout-source.pdf')
  const pdfResponse=await fetch(origin+'/api/pdf-to-word',{method:'POST',headers:{Cookie:cookie},body:pdfForm});assert.equal(pdfResponse.status,202);const pdfTask=(await pdfResponse.json()).task
  for(let tries=0;tries<300;tries++){result=(await api('/api/document-tasks/'+pdfTask.id)).task;if(['completed','failed'].includes(result.status))break;await pause(30)}
  assert.equal(result.status,'completed',result.error);assert.equal(result.metadata.totalPages,1);assert.equal(result.metadata.layout.tables,1);assert.equal(result.metadata.modelCalls,2);assert.equal(result.metadata.phase,'completed')
  assert.ok(result.metadata.layoutModel.warnings.length>0);assert.ok(result.markdownDownloadUrl);assert.equal(parse(result.previewHtml).querySelectorAll('table').length,1)
  const pdfDownload=await fetch(origin+result.downloadUrl,{headers:{Cookie:cookie}});assert.ok(pdfDownload.headers.get('Content-Disposition').includes('layout-source.docx'))
  assert.equal(parse((await mammoth.convertToHtml({buffer:Buffer.from(await pdfDownload.arrayBuffer())})).value).querySelectorAll('table').length,1)
})

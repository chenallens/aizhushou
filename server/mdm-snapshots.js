import fsp from 'node:fs/promises'
import path from 'node:path'

export async function readLatestMdmSnapshot(storageDir) {
  const root=path.join(storageDir,'mdm-snapshots')
  let entries
  try {entries=await fsp.readdir(root,{withFileTypes:true})} catch(error) {if(error.code==='ENOENT')return null;throw error}
  const captures=[]
  for (const entry of entries.filter(item=>item.isDirectory())) {
    try {
      const directory=path.join(root,entry.name)
      const manifest=JSON.parse(await fsp.readFile(path.join(directory,'manifest.json'),'utf8'))
      if(manifest.captureStatus==='complete' && manifest.syncStatus==='completed') captures.push({directory,manifest})
    } catch { /* Ignore incomplete capture directories. */ }
  }
  captures.sort((a,b)=>String(b.manifest.capturedAt).localeCompare(String(a.manifest.capturedAt)))
  if(!captures.length)return null
  const {directory,manifest}=captures[0]
  const snapshot={departments:[],employees:[]}
  for(const kind of ['department','employee']) {
    const pages=new Map()
    for(const response of manifest.responses) if(response.kind===kind && response.httpStatus===200 && response.businessStatus==='S')pages.set(response.page,response)
    const ordered=[...pages.values()].sort((a,b)=>a.page-b.page)
    if(!ordered.length || ordered.length!==ordered[0].totalPages)throw new Error('本地组织快照页数不完整')
    for(const [index,response] of ordered.entries()) {
      if(response.page!==index || !/^(department|employee)-page-\d{4}(-retry-\d{2})?\.json$/.test(response.file))throw new Error('本地组织快照文件索引不正确')
      const body=JSON.parse(await fsp.readFile(path.join(directory,response.file),'utf8'))
      if(body.status!=='S' || !Array.isArray(body.responseData))throw new Error('本地组织快照响应不正确')
      snapshot[kind==='department'?'departments':'employees'].push(...body.responseData)
    }
    if(snapshot[kind==='department'?'departments':'employees'].length!==ordered[0].totalElements)throw new Error('本地组织快照记录数不完整')
  }
  return {snapshot,syncId:manifest.syncId}
}

export async function createMdmSnapshotRecorder({storageDir,syncId,baseUrl}) {
  const directory = path.join(storageDir,'mdm-snapshots',syncId)
  await fsp.mkdir(directory,{recursive:true})
  const manifestPath = path.join(directory,'manifest.json')
  let sourceOrigin = ''
  try {sourceOrigin = new URL(baseUrl).origin} catch {}
  const manifest = {
    schemaVersion:1,syncId,createdAt:new Date().toISOString(),sourceOrigin,
    captureStatus:'running',syncStatus:'running',responses:[],
  }
  const saveManifest = async()=>{
    const temporaryPath = `${manifestPath}.tmp`
    await fsp.writeFile(temporaryPath,JSON.stringify(manifest,null,2),'utf8')
    await fsp.rename(temporaryPath,manifestPath)
  }
  await saveManifest()

  function info() {
    return {
      directory,manifestPath,captureStatus:manifest.captureStatus,
      responseFiles:manifest.responses.length,
    }
  }
  async function saveResponse({kind,page,attempt,httpStatus,contentType,rawBody}) {
    if (!['department','employee'].includes(kind) || !Number.isInteger(page) || page<0 || !Number.isInteger(attempt) || attempt<0) {
      throw new Error('原始人事响应的保存位置不正确')
    }
    let data
    try {data=JSON.parse(rawBody)} catch {data=null}
    const retry = attempt ? `-retry-${String(attempt).padStart(2,'0')}` : ''
    const file = `${kind}-page-${String(page+1).padStart(4,'0')}${retry}.${data ? 'json' : 'txt'}`
    await fsp.writeFile(path.join(directory,file),rawBody,'utf8')
    manifest.responses.push({
      kind,page,attempt,httpStatus,contentType,file,
      businessStatus:data?.status||null,
      records:Array.isArray(data?.responseData)?data.responseData.length:null,
      totalElements:data?.totalElements??null,totalPages:data?.totalPages??null,
    })
    await saveManifest()
  }
  async function completeCapture() {
    manifest.captureStatus='complete'
    manifest.capturedAt=new Date().toISOString()
    await saveManifest()
  }
  async function finish(syncStatus,error=null) {
    manifest.syncStatus=syncStatus
    manifest.finishedAt=new Date().toISOString()
    if (manifest.captureStatus!=='complete') manifest.captureStatus='incomplete'
    if (error) manifest.error=error
    await saveManifest()
  }
  return {info,saveResponse,completeCapture,finish}
}

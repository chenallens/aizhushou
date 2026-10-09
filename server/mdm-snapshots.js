import fsp from 'node:fs/promises'
import path from 'node:path'

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

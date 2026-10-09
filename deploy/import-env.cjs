const fs=require('node:fs')
const path=require('node:path')
const crypto=require('node:crypto')
const dotenv=require('dotenv')

function quote(value) {
  for(const delimiter of ["'",'`','"']) {
    if(!value.includes(delimiter)&&(delimiter!=='"'||!/[\\][nr]/.test(value)))return `${delimiter}${value}${delimiter}`
  }
  throw new Error('A configuration value contains unsupported quote combinations. Import manually instead.')
}
function mergeConfiguration(current,previous) {
  if(previous.STORAGE_DIR)throw new Error('Old configuration uses a custom STORAGE_DIR. Preserve that data location and configure the upgrade manually.')
  const merged={...current,...previous,SERVER_PORT:'4178',MOCK_AI:'false'}
  delete merged.STORAGE_DIR
  delete merged.PLATFORM_SCHEDULER_DISABLED
  if(!merged.SESSION_SECRET||['change-this-session-secret','aizhushou-local-dev-secret'].includes(merged.SESSION_SECRET))merged.SESSION_SECRET=crypto.randomBytes(32).toString('hex')
  const content='# Imported server configuration; credentials must remain private.\r\n'+Object.entries(merged).map(([key,value])=>`${key}=${quote(String(value))}`).join('\r\n')+'\r\n'
  const parsed=dotenv.parse(content)
  if(Object.entries(merged).some(([key,value])=>parsed[key]!==String(value)))throw new Error('Configuration round-trip validation failed. No configuration was changed.')
  return content
}
function main(oldPath) {
  if(!oldPath)throw new Error('Provide the old server .env path.')
  const previousPath=path.resolve(oldPath.trim().replace(/^"|"$/g,''))
  const target=path.resolve(__dirname,'..','.env')
  if(previousPath.toLowerCase()===target.toLowerCase())throw new Error('Select the OLD server .env, not this new deployment .env.')
  const content=mergeConfiguration(dotenv.parse(fs.readFileSync(target,'utf8')),dotenv.parse(fs.readFileSync(previousPath,'utf8')))
  const backup=`${target}.before-import-${Date.now()}`
  fs.copyFileSync(target,backup)
  fs.writeFileSync(`${target}.tmp`,content,'utf8')
  fs.renameSync(`${target}.tmp`,target)
  console.log('Old server values preserved; missing new settings retained. Port=4178; MOCK_AI=false.')
  console.log('Configuration backup saved beside .env. Storage data was not changed.')
}
module.exports={mergeConfiguration}
if(require.main===module){try{main(process.argv[2])}catch(error){console.error(error.message);process.exitCode=1}}

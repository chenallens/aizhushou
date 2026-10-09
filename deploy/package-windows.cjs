const fs=require('node:fs/promises')
const path=require('node:path')
const crypto=require('node:crypto')
const {execFileSync}=require('node:child_process')
const dotenv=require('dotenv')

async function main() {
  const project=path.resolve(__dirname,'..')
  if(process.argv[2]==='--finalize') {
    const target=path.resolve(process.argv[3])
    await fs.access(path.join(target,'nginx.exe'))
    const manifest=JSON.parse(await fs.readFile(path.join(target,'release-manifest.json'),'utf8'))
    manifest.codeCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:project,encoding:'utf8',windowsHide:true}).trim()
    manifest.finalizedAt=new Date().toISOString()
    for(const file of ['README.md','AI助手项目现状.md','10月新增功能使用说明.md'])await fs.copyFile(path.join(project,file),path.join(target,'app','aizhushou',file))
    await fs.copyFile(path.join(project,'Windows服务器发布与测试说明.md'),path.join(target,'Windows服务器发布与测试说明.md'))
    for(const file of ['start.bat','start-aizhushou.bat','stop-aizhushou.bat','restart-aizhushou.bat','import-old-config.bat','manage-service.ps1']) {
      const content=(await fs.readFile(path.join(project,'deploy',file),'utf8')).replace(/\r?\n/g,'\r\n')
      await fs.writeFile(path.join(target,file),content,'utf8')
    }
    await fs.copyFile(path.join(project,'deploy','import-env.cjs'),path.join(target,'app','aizhushou','deploy','import-env.cjs'))
    await fs.writeFile(path.join(target,'release-manifest.json'),JSON.stringify(manifest,null,2),'utf8')
    console.log(JSON.stringify({directory:target,codeCommit:manifest.codeCommit,finalized:true}));return
  }
  const base=path.resolve(process.argv[2]||path.join(project,'..','nginx-1.23.2'))
  const target=path.resolve(process.argv[3]||path.join(project,'..','releases','20261009','nginx-1.23.2'))
  try {await fs.access(target);throw new Error('Release directory already exists; use a new output directory.')} catch(error) {if(error.code!=='ENOENT')throw error}
  const app=path.join(target,'app','aizhushou')
  for(const directory of ['conf','logs','temp','app/aizhushou/storage'])await fs.mkdir(path.join(target,directory),{recursive:true})
  await fs.copyFile(path.join(base,'nginx.exe'),path.join(target,'nginx.exe'))
  for(const file of ['nginx.conf','mime.types'])await fs.copyFile(path.join(base,'conf',file),path.join(target,'conf',file))
  await fs.mkdir(path.join(target,'html'),{recursive:true})
  await fs.copyFile(path.join(base,'html','50x.html'),path.join(target,'html','50x.html'))
  await fs.cp(path.join(project,'dist'),path.join(target,'html','aizhushou'),{recursive:true})
  await fs.cp(path.join(project,'dist'),path.join(app,'dist'),{recursive:true})
  await fs.cp(path.join(project,'server'),path.join(app,'server'),{recursive:true})
  await fs.access(path.join(project,'resources','standards','ss020101-a3.pdf'))
  await fs.mkdir(path.join(app,'resources','standards'),{recursive:true})
  await fs.copyFile(path.join(project,'resources','standards','ss020101-a3.pdf'),path.join(app,'resources','standards','ss020101-a3.pdf'))
  await fs.cp(path.join(base,'app','aizhushou','runtime'),path.join(app,'runtime'),{recursive:true})
  for(const file of ['package.json','package-lock.json','.env.example','README.md','AI助手项目现状.md','10月新增功能使用说明.md'])await fs.copyFile(path.join(project,file),path.join(app,file))
  const config=dotenv.parse(await fs.readFile(path.join(project,'.env'),'utf8'))
  delete config.STORAGE_DIR
  delete config.PLATFORM_SCHEDULER_DISABLED
  config.SERVER_PORT='4178';config.MOCK_AI='false'
  config.SESSION_SECRET=crypto.randomBytes(32).toString('hex')
  const {mergeConfiguration}=require('./import-env.cjs')
  await fs.writeFile(path.join(app,'.env'),mergeConfiguration(config,{}),'utf8')
  await fs.mkdir(path.join(app,'deploy'),{recursive:true})
  await fs.copyFile(path.join(project,'deploy','import-env.cjs'),path.join(app,'deploy','import-env.cjs'))
  const scripts=['start.bat','start-aizhushou.bat','stop-aizhushou.bat','restart-aizhushou.bat','import-old-config.bat','manage-service.ps1']
  for(const file of scripts) {
    const content=(await fs.readFile(path.join(project,'deploy',file),'utf8')).replace(/\r?\n/g,'\r\n')
    await fs.writeFile(path.join(target,file),content,'utf8')
  }
  await fs.copyFile(path.join(project,'Windows服务器发布与测试说明.md'),path.join(target,'Windows服务器发布与测试说明.md'))
  const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:project,encoding:'utf8',windowsHide:true}).trim()
  const reference=await fs.readFile(path.join(app,'resources','standards','ss020101-a3.pdf'))
  const manifest={release:path.basename(path.dirname(target)),codeCommit:commit,builtAt:new Date().toISOString(),server:'172.28.200.66',ssoCallback:'/sso/login',ports:{nginx:80,api:4178},runtime:'Windows x64 bundled Node',storage:'empty; preserve server storage when upgrading',resources:[{file:'resources/standards/ss020101-a3.pdf',bytes:reference.length,sha256:crypto.createHash('sha256').update(reference).digest('hex')}],configuration:'private .env and internal standard included; not for public sharing'}
  await fs.writeFile(path.join(target,'release-manifest.json'),JSON.stringify(manifest,null,2),'utf8')
  console.log(JSON.stringify({directory:target,codeCommit:commit,storageIncluded:false,privateConfigIncluded:true,dependencies:'install production dependencies before archiving'}))
}
main().catch(error=>{console.error(error.message);process.exitCode=1})

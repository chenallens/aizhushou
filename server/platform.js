import crypto from 'node:crypto'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { createMdmClient } from './mdm-client.js'
import { normalizeMdmSnapshot } from './mdm-normalize.js'
import { createUsageStats } from './usage-stats.js'

const scrypt = promisify(crypto.scrypt)
const initialPassword = '123456'
export const roles = [
  { id:'super_admin', name:'超级管理员', permissions:['users.manage','roles.manage','organization.sync','glossary.manage','prompts.1','prompts.2','prompts.3','feedback.reply','audit.read'] },
  { id:'glossary_admin', name:'翻译术语库管理员', permissions:['glossary.manage'] },
  { id:'prompt_plant_1', name:'一厂提示词管理员', permissions:['prompts.1'] },
  { id:'prompt_plant_2', name:'二厂提示词管理员', permissions:['prompts.2'] },
  { id:'prompt_plant_3', name:'三厂提示词管理员', permissions:['prompts.3'] },
]

async function hashPassword(value) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = await scrypt(String(value),salt,32)
  return `${salt}:${hash.toString('hex')}`
}

async function verifyPassword(value,stored) {
  const [salt,expected] = String(stored || '').split(':')
  if (!salt || !expected) return false
  const actual = await scrypt(String(value),salt,32)
  const expectedBuffer = Buffer.from(expected,'hex')
  return expectedBuffer.length === actual.length && crypto.timingSafeEqual(actual,expectedBuffer)
}

export function latestWeeklySlot(date = new Date()) {
  const local = new Date(date.getTime()+8*3600_000)
  const days = (local.getUTCDay()+6)%7
  let slot = new Date(Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate()-days,4)-8*3600_000)
  if (slot > date) slot = new Date(slot.getTime()-7*86400_000)
  return slot.toISOString()
}

export function nextWeeklySlot(date = new Date()) {
  return new Date(new Date(latestWeeklySlot(date)).getTime()+7*86400_000).toISOString()
}

export async function createPlatform({ db, saveDatabase, session, storageDir }) {
  function all(sql,params=[]) {
    const statement = db.prepare(sql)
    try {
      statement.bind(params)
      const rows = []
      while (statement.step()) rows.push(statement.getAsObject())
      return rows
    } finally { statement.free() }
  }
  const get = (sql,params=[])=>all(sql,params)[0] || null
  function run(sql,params=[]) { db.run(sql,params); saveDatabase() }
  function transaction(action) {
    db.run('BEGIN TRANSACTION')
    try { action(); db.run('COMMIT') } catch(error) { db.run('ROLLBACK'); throw error }
    saveDatabase()
  }
  const timestamp = ()=>new Date().toISOString()
  const syncLogDir = path.join(storageDir,'logs')
  fs.mkdirSync(syncLogDir,{recursive:true})
  const syncLogPath = path.join(syncLogDir,'mdm-sync.log')
  function logSync(id,event,details = {}) {
    const line = JSON.stringify({timestamp:timestamp(),syncId:id,event,...details})
    console.info(`[MDM:${id.slice(0,8)}] ${line}`)
    try {fs.appendFileSync(syncLogPath,`${line}\n`)} catch {console.warn('[MDM] 无法写入同步日志，诊断仍保存在同步记录中')}
  }
  function audit(actor,action,target,details={}) {
    db.run('INSERT INTO administration_audit (actor_id,action,target_id,details_json,created_at) VALUES (?,?,?,?,?)', [actor?.id || null,action,target,JSON.stringify(details),timestamp()])
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS departments (id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, employee_id TEXT UNIQUE, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      department_id TEXT, password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 1,
      auth_version INTEGER NOT NULL DEFAULT 1, builtin INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT NOT NULL, role_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id,role_id));
    CREATE TABLE IF NOT EXISTS login_sessions (sid TEXT PRIMARY KEY, data_json TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS organization_sync_runs (id TEXT PRIMARY KEY, trigger TEXT NOT NULL, actor_id TEXT, status TEXT NOT NULL,
      stage TEXT NOT NULL, counts_json TEXT NOT NULL DEFAULT '{}', error TEXT, started_at TEXT NOT NULL, finished_at TEXT);
    CREATE TABLE IF NOT EXISTS administration_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL,
      target_id TEXT, details_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS statistics_archives (period TEXT NOT NULL, period_key TEXT NOT NULL, data_json TEXT NOT NULL,
      archived_at TEXT NOT NULL, PRIMARY KEY (period,period_key));
  `)
  const eventColumns = all('PRAGMA table_info(events)').map(column=>column.name)
  for (const [name,type] of [['user_id','TEXT'],['department_id','TEXT'],['department_name','TEXT'],['request_key','TEXT']]) {
    if (!eventColumns.includes(name)) db.run(`ALTER TABLE events ADD COLUMN ${name} ${type}`)
  }
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS events_request_key ON events(request_key)')
  db.run('CREATE INDEX IF NOT EXISTS events_period ON events(created_at,type)')
  for (const table of ['document_tasks','translations']) {
    if (!all(`PRAGMA table_info(${table})`).some(column=>column.name==='owner_id')) db.run(`ALTER TABLE ${table} ADD COLUMN owner_id TEXT`)
  }
  db.run('DELETE FROM login_sessions WHERE expires_at <= ?', [Date.now()])
  db.run("UPDATE organization_sync_runs SET status = 'failed', stage = '服务重启，同步已中断', error = '请重新同步', finished_at = ? WHERE status = 'running'", [timestamp()])

  const adminUsername = String(process.env.ADMIN_USERNAME || 'admin')
  const adminPassword = process.env.ADMIN_PASSWORD || 'change-me'
  const builtin = get("SELECT * FROM users WHERE id = 'builtin:admin'")
  const adminHash = builtin && await verifyPassword(adminPassword,builtin.password_hash) ? builtin.password_hash : await hashPassword(adminPassword)
  db.run(`INSERT INTO users (id,username,name,password_hash,must_change_password,builtin,created_at,updated_at)
    VALUES ('builtin:admin',?,?,?,0,1,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash,
    auth_version=users.auth_version+CASE WHEN users.password_hash != excluded.password_hash THEN 1 ELSE 0 END,active=1,updated_at=excluded.updated_at`,
  [adminUsername,'系统管理员',adminHash,timestamp(),timestamp()])
  db.run("INSERT OR IGNORE INTO user_roles (user_id,role_id,created_at) VALUES ('builtin:admin','super_admin',?)", [timestamp()])
  saveDatabase()
  const dummyHash = await hashPassword(crypto.randomBytes(16).toString('hex'))
  const stats = createUsageStats({all,get,run})
  const mdm = createMdmClient()
  let syncRunning = false
  const loginAttempts = new Map()

  function publicUser(row) {
    if (!row) return null
    const assignedRoles = all('SELECT role_id FROM user_roles WHERE user_id = ? ORDER BY role_id', [row.id]).map(item=>item.role_id)
    const permissions = [...new Set(roles.filter(role=>assignedRoles.includes(role.id)).flatMap(role=>role.permissions))]
    return {
      id:row.id, username:row.username, name:row.name,
      departmentId:row.department_id, departmentName:row.builtin ? '系统账户' : get('SELECT name FROM departments WHERE id = ?', [row.department_id])?.name || '未归属部门',
      roles:assignedRoles, permissions, mustChangePassword:Boolean(row.must_change_password), builtin:Boolean(row.builtin),
      isAdmin:permissions.length>0, isSuperAdmin:assignedRoles.includes('super_admin'),
    }
  }

  function attachUser(req,_res,next) {
    const row = req.session?.userId ? get('SELECT * FROM users WHERE id = ?', [req.session.userId]) : null
    req.user = row?.active && row.auth_version === req.session.authVersion ? publicUser(row) : null
    if (req.session?.userId && !req.user) { delete req.session.userId; delete req.session.authVersion }
    next()
  }

  function requireUser(req,res,next) {
    if (!req.user) { res.status(401).json({ error:'请先登录', code:'LOGIN_REQUIRED' }); return }
    if (req.user.mustChangePassword) { res.status(403).json({ error:'请先修改初始密码', code:'PASSWORD_CHANGE_REQUIRED' }); return }
    next()
  }

  function requirePermission(permission) {
    return (req,res,next)=>requireUser(req,res,()=>{
      if (!req.user.permissions.includes(permission)) { res.status(403).json({error:'没有此操作的权限'}); return }
      next()
    })
  }

  class SqliteSessionStore extends session.Store {
    get(sid,callback) {
      try {
        const row=get('SELECT * FROM login_sessions WHERE sid = ? AND expires_at > ?', [sid,Date.now()])
        callback(null,row ? JSON.parse(row.data_json) : null)
      } catch(error) { callback(error) }
    }
    set(sid,value,callback=()=>{}) {
      try {
        const expiresAt=value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now()+8*3600_000
        run('INSERT INTO login_sessions (sid,data_json,expires_at) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET data_json=excluded.data_json,expires_at=excluded.expires_at', [sid,JSON.stringify(value),expiresAt])
        callback()
      } catch(error) { callback(error) }
    }
    destroy(sid,callback=()=>{}) { try { run('DELETE FROM login_sessions WHERE sid = ?', [sid]); callback() } catch(error) { callback(error) } }
    touch(sid,value,callback=()=>{}) { this.set(sid,value,callback) }
  }

  function recordEvent(type,req) {
    const user = req?.user
    const requestKey = type !== 'visit' && typeof req?.body?.requestId === 'string' && /^[\w-]{8,100}$/.test(req.body.requestId)
      ? `${user?.id || 'guest'}:${type}:${req.body.requestId}` : null
    run('INSERT OR IGNORE INTO events (type,created_at,user_id,department_id,department_name,request_key) VALUES (?,?,?,?,?,?)',
      [type,timestamp(),user?.id || null,user ? user.departmentId || (user.builtin ? 'system' : 'unassigned') : null,user?.departmentName || null,requestKey])
  }

  function parsePage(query) {
    return { page:Math.max(1,Math.floor(Number(query.page)||1)), pageSize:Math.min(100,Math.max(1,Math.floor(Number(query.pageSize)||20))) }
  }
  function searchUsers(query={},roleId=null) {
    const {page,pageSize}=parsePage(query)
    const params=[]
    let where='u.active = 1'
    if (roleId) { where+=' AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role_id=?)'; params.push(roleId) }
    else where+=' AND u.builtin = 0'
    if (query.departmentId) { where+=' AND u.department_id = ?'; params.push(String(query.departmentId)) }
    const term=String(query.q||'').trim().slice(0,100)
    if (term) { where+=" AND (u.name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')"; const pattern=`%${term.replace(/[\\%_]/g,'\\$&')}%`; params.push(pattern,pattern) }
    const total=get(`SELECT COUNT(*) AS count FROM users u WHERE ${where}`,params).count
    const rows=all(`SELECT u.* FROM users u WHERE ${where} ORDER BY u.builtin DESC,u.name,u.username LIMIT ? OFFSET ?`, [...params,pageSize,(page-1)*pageSize])
    return {items:rows.map(row=>publicUser(row)),total,page,pageSize,totalPages:Math.max(1,Math.ceil(total/pageSize))}
  }

  function syncState() {
    const deserialize=row=>row && {id:row.id,trigger:row.trigger,status:row.status,stage:row.stage,counts:JSON.parse(row.counts_json),error:row.error,startedAt:row.started_at,finishedAt:row.finished_at}
    return {
      running:syncRunning, lastRun:deserialize(get('SELECT * FROM organization_sync_runs ORDER BY started_at DESC LIMIT 1')),
      lastSuccess:deserialize(get("SELECT * FROM organization_sync_runs WHERE status = 'completed' ORDER BY started_at DESC LIMIT 1")),
      nextRun:nextWeeklySlot(),items:all('SELECT * FROM organization_sync_runs ORDER BY started_at DESC LIMIT 10').map(deserialize),
    }
  }

  function startSync(trigger,actor) {
    if (syncRunning) return null
    syncRunning=true
    const id=crypto.randomUUID()
    run('INSERT INTO organization_sync_runs (id,trigger,actor_id,status,stage,started_at) VALUES (?,?,?,?,?,?)', [id,trigger,actor?.id||null,'running','正在获取人事接口数据',timestamp()])
    logSync(id,'started',{trigger})
    setImmediate(async()=>{
      let diagnostics = null
      try {
        const snapshot=await mdm.readSnapshot(progress=>{
          run('UPDATE organization_sync_runs SET stage = ?, counts_json = ? WHERE id = ?', [`正在读取${progress.kind==='department'?'部门':'人员'}：${progress.page}/${progress.totalPages} 页`,JSON.stringify(progress),id])
          logSync(id,'page',progress)
        })
        const existing=new Map(all('SELECT * FROM users WHERE builtin=0').map(item=>[item.id,item]))
        const normalized=normalizeMdmSnapshot(snapshot,{adminUsername,existingUsers:[...existing.values()]})
        diagnostics = normalized.diagnostics
        logSync(id,'validated',{diagnostics})
        if (!normalized.users.length && [...existing.values()].some(item=>item.active)) throw new Error('人员接口返回空快照，保留原有人员数据')
        const newUsers=normalized.users.filter(item=>!existing.has(item.id))
        const hashes=new Map()
        for (let offset=0;offset<newUsers.length;offset+=4) {
          const batch=newUsers.slice(offset,offset+4)
          await Promise.all(batch.map(async item=>hashes.set(item.id,await hashPassword(initialPassword))))
          run('UPDATE organization_sync_runs SET stage=? WHERE id=?', [`正在初始化新账号：${Math.min(offset+4,newUsers.length)}/${newUsers.length}`,id])
        }
        const deactivationDeferred = diagnostics.skippedRecords>0
        const counts={departments:normalized.departments.length,employees:normalized.users.length,added:newUsers.length,updated:0,disabled:0,diagnostics,deactivationDeferred}
        const seen=new Set(normalized.users.map(item=>item.id))
        transaction(()=>{
          if (!deactivationDeferred) db.run('UPDATE departments SET active=0')
          for (const department of normalized.departments) db.run('INSERT INTO departments (id,name,active,updated_at) VALUES (?,?,1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,active=1,updated_at=excluded.updated_at', [department.id,department.name,timestamp()])
          // Temporarily free mutable usernames so exchanged employee accounts can be updated atomically.
          for (const item of normalized.users) {
            if (existing.has(item.id)) db.run('UPDATE users SET username=? WHERE id=?', [`sync:${id}:${item.employeeId}`,item.id])
            const occupied=get('SELECT * FROM users WHERE username=? AND id!=?', [item.username,item.id])
            if (occupied && !seen.has(occupied.id) && !occupied.builtin) db.run('UPDATE users SET username=?,active=0,auth_version=auth_version+1 WHERE id=?', [`removed:${occupied.id}:${id}`,occupied.id])
          }
          for (const item of normalized.users) {
            const previous=existing.get(item.id)
            if (previous) {
              if (previous.name!==item.name || previous.username!==item.username || previous.department_id!==item.departmentId || !previous.active) counts.updated++
              db.run('UPDATE users SET username=?,name=?,department_id=?,active=1,updated_at=? WHERE id=?', [item.username,item.name,item.departmentId,timestamp(),item.id])
            } else db.run('INSERT INTO users (id,employee_id,username,name,department_id,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', [item.id,item.employeeId,item.username,item.name,item.departmentId,hashes.get(item.id),timestamp(),timestamp()])
          }
          for (const previous of existing.values()) if (!deactivationDeferred && !seen.has(previous.id) && previous.active) {
            counts.disabled++
            db.run('UPDATE users SET active=0,auth_version=auth_version+1,updated_at=? WHERE id=?', [timestamp(),previous.id])
          }
          const stage = diagnostics.skippedRecords ? `同步完成，${diagnostics.skippedRecords} 条异常记录未导入` : '同步完成'
          db.run("UPDATE organization_sync_runs SET status='completed',stage=?,counts_json=?,finished_at=? WHERE id=?", [stage,JSON.stringify(counts),timestamp(),id])
          audit(actor,'organization.sync',id,counts)
        })
        logSync(id,'completed',{counts})
      } catch(error) {
        diagnostics = error.diagnostics || diagnostics
        if (diagnostics) run('UPDATE organization_sync_runs SET counts_json=? WHERE id=?',[JSON.stringify({diagnostics}),id])
        run("UPDATE organization_sync_runs SET status='failed',stage='同步失败，保留上次成功数据',error=?,finished_at=? WHERE id=?", [error.message,timestamp(),id])
        logSync(id,'failed',{error:error.message,diagnostics})
      } finally {syncRunning=false}
    })
    return id
  }

  function registerRoutes(app) {
    app.get('/api/me',(req,res)=>res.json(req.user ? { ...req.user,authenticated:true } : {authenticated:false,isAdmin:false,isSuperAdmin:false,roles:[],permissions:[]}))
    app.post('/api/login',async(req,res)=>{
      const username=String(req.body?.username||'').trim(),password=String(req.body?.password||'')
      if (username.length>200 || password.length>256) {res.status(400).json({error:'账号或密码长度不正确'});return}
      const attemptKey=`${req.ip}:${username}`
      for (const [key,attempt] of loginAttempts) if (attempt.expiresAt<Date.now()) loginAttempts.delete(key)
      const attempt=loginAttempts.get(attemptKey)
      if (attempt?.count>=15) {res.status(429).json({error:'登录尝试过多，请稍后重试'});return}
      const row=get('SELECT * FROM users WHERE username=? AND active=1',[username])
      const valid=await verifyPassword(password,row?.password_hash || dummyHash)
      if (!row || !valid) {
        loginAttempts.set(attemptKey,{count:(attempt?.count||0)+1,expiresAt:attempt?.expiresAt||Date.now()+15*60_000})
        res.status(401).json({error:'账号或密码不正确'});return
      }
      loginAttempts.delete(attemptKey)
      await new Promise((resolve,reject)=>req.session.regenerate(error=>error?reject(error):resolve()))
      req.session.userId=row.id;req.session.authVersion=row.auth_version
      res.json({ok:true,...publicUser(row),authenticated:true})
    })
    app.post('/api/logout',(req,res)=>req.session.destroy(()=>{res.clearCookie('aizhushou.sid');res.json({ok:true})}))
    app.post('/api/account/password',async(req,res)=>{
      if (!req.user) {res.status(401).json({error:'请先登录'});return}
      if (req.user.builtin) {res.status(400).json({error:'系统管理员密码请在服务器 .env 中修改并重启'});return}
      const password=String(req.body?.password||'')
      const row=get('SELECT * FROM users WHERE id=?',[req.user.id])
      if (!await verifyPassword(req.body?.currentPassword||'',row.password_hash)) {res.status(400).json({error:'当前密码不正确'});return}
      if (password.length<6 || password.length>128 || password===initialPassword || password===String(req.body?.currentPassword||'')) {res.status(400).json({error:'新密码需为 6 至 128 位，且不能与初始密码或当前密码相同'});return}
      const hash=await hashPassword(password)
      transaction(()=>{db.run('UPDATE users SET password_hash=?,must_change_password=0,auth_version=auth_version+1,updated_at=? WHERE id=?',[hash,timestamp(),row.id]);audit(req.user,'account.password',row.id)})
      req.session.authVersion=row.auth_version+1
      res.json({ok:true})
    })
    app.get('/api/admin/roles',requirePermission('roles.manage'),(_req,res)=>res.json({items:roles.map(role=>({...role,memberCount:get('SELECT COUNT(*) AS count FROM user_roles r JOIN users u ON r.user_id=u.id WHERE r.role_id=? AND u.active=1',[role.id]).count}))}))
    app.get('/api/admin/roles/:roleId/members',requirePermission('roles.manage'),(req,res)=>{
      if (!roles.some(role=>role.id===req.params.roleId)) {res.status(404).json({error:'角色不存在'});return}
      res.json(searchUsers(req.query,req.params.roleId))
    })
    app.post('/api/admin/roles/:roleId/members',requirePermission('roles.manage'),(req,res)=>{
      const roleId=req.params.roleId
      const ids=[...new Set(Array.isArray(req.body?.userIds)?req.body.userIds:[])]
      if (ids.length>100) {res.status(400).json({error:'每次最多添加 100 位角色成员'});return}
      if (!roles.some(role=>role.id===roleId) || !ids.length || ids.some(id=>typeof id!=='string'||!get('SELECT id FROM users WHERE id=? AND active=1',[id]))) {res.status(400).json({error:'请选择有效的角色和用户'});return}
      transaction(()=>{for (const id of ids) {db.run('INSERT OR IGNORE INTO user_roles (user_id,role_id,created_at) VALUES (?,?,?)',[id,roleId,timestamp()]);audit(req.user,'role.add',id,{roleId})}})
      res.json({ok:true})
    })
    app.delete('/api/admin/roles/:roleId/members/:userId',requirePermission('roles.manage'),(req,res)=>{
      if (req.params.userId==='builtin:admin') {res.status(400).json({error:'内置系统管理员角色保留'});return}
      transaction(()=>{db.run('DELETE FROM user_roles WHERE user_id=? AND role_id=?',[req.params.userId,req.params.roleId]);audit(req.user,'role.remove',req.params.userId,{roleId:req.params.roleId})})
      res.json({ok:true})
    })
    app.get('/api/admin/users',requirePermission('users.manage'),(req,res)=>res.json(searchUsers(req.query)))
    app.post('/api/admin/users/:userId/reset-password',requirePermission('users.manage'),async(req,res)=>{
      const row=get('SELECT * FROM users WHERE id=? AND builtin=0 AND active=1',[req.params.userId])
      if (!row) {res.status(404).json({error:'未找到可重置的员工账户'});return}
      const hash=await hashPassword(initialPassword)
      transaction(()=>{db.run('UPDATE users SET password_hash=?,must_change_password=1,auth_version=auth_version+1,updated_at=? WHERE id=?',[hash,timestamp(),row.id]);audit(req.user,'account.reset',row.id)})
      res.json({ok:true})
    })
    app.get('/api/admin/departments',requirePermission('users.manage'),(_req,res)=>res.json({items:all('SELECT d.id,d.name,(SELECT COUNT(*) FROM users u WHERE u.department_id=d.id AND u.active=1 AND u.builtin=0) AS employeeCount FROM departments d WHERE d.active=1 ORDER BY d.name'),totalEmployees:get('SELECT COUNT(*) AS count FROM users WHERE active=1 AND builtin=0').count}))
    app.get('/api/admin/organization-sync',requirePermission('organization.sync'),(_req,res)=>res.json(syncState()))
    app.post('/api/admin/organization-sync',requirePermission('organization.sync'),(req,res)=>{
      const id=startSync('manual',req.user)
      if (!id) {res.status(409).json({error:'已有同步任务正在进行'});return}
      res.status(202).json({ok:true,id})
    })
    app.get('/api/admin/operations',requirePermission('audit.read'),(req,res)=>res.json({items:all('SELECT a.action,a.target_id AS targetId,a.created_at AS createdAt,u.name AS actorName FROM administration_audit a LEFT JOIN users u ON a.actor_id=u.id ORDER BY a.id DESC LIMIT 100')}))
    app.get('/api/stats',(req,res)=>{
      try {res.json(stats.report(req.query))} catch(error) {res.status(400).json({error:error.message})}
    })
  }

  function startSchedules() {
    const tick=()=>{
      try {
        stats.archiveDue()
        run('DELETE FROM login_sessions WHERE expires_at<=?',[Date.now()])
        const slot=latestWeeklySlot()
        const initialized=get("SELECT id FROM organization_sync_runs WHERE status='completed' LIMIT 1")
        const attempted=get("SELECT id FROM organization_sync_runs WHERE started_at>=? AND (trigger='scheduled' OR status='completed') LIMIT 1",[slot])
        if (initialized && !attempted && !syncRunning) startSync('scheduled',null)
      } catch(error) {console.error(`[Platform] schedule failed: ${error.message}`)}
    }
    if (process.env.PLATFORM_SCHEDULER_DISABLED==='true') return
    tick()
    setInterval(tick,60_000).unref()
  }

  return {store:new SqliteSessionStore(),attachUser,requireUser,requirePermission,registerRoutes,recordEvent,startSchedules}
}

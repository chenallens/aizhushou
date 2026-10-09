import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import initSqlJs from 'sql.js'
import session from 'express-session'
import {organizationIndex} from '../server/organization.js'
import {createPlatform} from '../server/platform.js'
import {createMdmSnapshotRecorder,readLatestMdmSnapshot} from '../server/mdm-snapshots.js'
import {createUsageStats} from '../server/usage-stats.js'

const SQL=await initSqlJs()
const companies=[{id:'100',name:'公司甲'},{id:'200',name:'公司乙'}]
const departments=[
  {id:'100',name:'制造一厂',companyId:'100',parentId:null},
  {id:'200',name:'设备组',companyId:'100',parentId:'100'},
  {id:'201',name:'设备组',companyId:'100',parentId:'100'},
  {id:'300',name:'制造一厂',companyId:'200',parentId:null},
]
const queryDb=db=>{
  const all=(sql,params=[])=>{const stmt=db.prepare(sql);try{stmt.bind(params);const rows=[];while(stmt.step())rows.push(stmt.getAsObject());return rows}finally{stmt.free()}}
  return {all,get:(sql,params)=>all(sql,params)[0]||null,run:(sql,params)=>db.run(sql,params)}
}

test('Company and department ID collisions, sibling duplicates and descendant counts',()=>{
  const index=organizationIndex(companies,departments,[{companyId:'100',departmentId:'200',count:3},{companyId:'100',departmentId:'201',count:25},{companyId:'200',departmentId:'300',count:2}])
  assert.equal(index.companyMap.get('200').employeeCount,2)
  assert.equal(index.departmentMap.get('200').employeeCount,3)
  assert.equal(index.departmentMap.get('100').employeeCount,28)
  assert.equal(index.departmentMap.get('100').directCount,0)
  assert.equal(index.departmentMap.get('201').ambiguous,true)
  assert.equal(index.departmentMap.get('200').path,'公司甲 / 制造一厂 / 设备组')
  assert.deepEqual(new Set(index.descendants('100')),new Set(['100','200','201']))
})

test('Frozen event ancestry and companies aggregate without double counting, including old archives',()=>{
  const db=new SQL.Database()
  db.run(`CREATE TABLE companies(id TEXT,name TEXT,active INTEGER);
    CREATE TABLE departments(id TEXT,name TEXT,company_id TEXT,parent_id TEXT,active INTEGER);
    CREATE TABLE events(id INTEGER PRIMARY KEY,type TEXT,created_at TEXT,department_id TEXT,department_name TEXT,company_id TEXT,company_name TEXT,department_path_json TEXT);
    CREATE TABLE statistics_archives(period TEXT,period_key TEXT,data_json TEXT,archived_at TEXT);`)
  for(const item of companies)db.run('INSERT INTO companies VALUES (?,?,1)',[item.id,item.name])
  for(const item of departments)db.run('INSERT INTO departments VALUES (?,?,?,?,1)',[item.id,item.name,item.companyId,item.parentId])
  const stamp='2025-10-03T00:00:00.000Z'
  const originalPath=JSON.stringify([{id:'100',name:'制造一厂'},{id:'200',name:'设备组'}])
  db.run('INSERT INTO events VALUES (?,?,?,?,?,?,?,?)',[1,'qa_click',stamp,'200','设备组','100','公司甲',originalPath])
  db.run('INSERT INTO events VALUES (?,?,?,?,?,?,?,?)',[2,'translation_click',stamp,'300','制造一厂','200','公司乙',JSON.stringify([{id:'300',name:'制造一厂'}])])
  db.run('INSERT INTO events VALUES (?,?,?,?,?,?,?,?)',[3,'ragflow_click',stamp,'100','旧一厂名称',null,null,null])
  const stats=createUsageStats(queryDb(db))
  assert.equal(stats.report({key:'2025-10'}).total,3)
  const company=stats.report({key:'2025-10',companyId:'100'})
  assert.equal(company.total,1)
  assert.equal(company.departments.find(item=>item.id==='100').qaNativeUses,1)
  assert.equal(stats.report({key:'2025-10',companyId:'100',departmentId:'100'}).total,1)
  assert.equal(stats.report({key:'2025-10',departmentId:'100'}).total,2)
  db.run("UPDATE departments SET parent_id='300',company_id='200' WHERE id='200'")
  assert.equal(stats.report({key:'2025-10',companyId:'100',departmentId:'100'}).total,1)
  stats.archiveDue(new Date('2025-11-01T04:00:00+08:00'))
  db.run("UPDATE companies SET name='公司甲新名称' WHERE id='100'")
  assert.equal(stats.report({key:'2025-10',companyId:'100'}).isArchived,true)
  assert.equal(stats.report({key:'2025-10',companyId:'100'}).total,1)
  db.run('INSERT INTO statistics_archives VALUES (?,?,?,?)',['month','2025-09',JSON.stringify({departments:[{id:'old',name:'旧部门',qaNativeUses:4,ragflowUses:0,translationUses:0,pdfUses:0,standardUses:0,total:4}]}),stamp])
  assert.equal(stats.report({key:'2025-09'}).total,4)
  assert.equal(stats.report({key:'2025-09',companyId:'100'}).total,0)
  db.close()
})

test('Offline hierarchy migration keeps stable identity, passwords, sessions, roles and events; executes only once',async(t)=>{
  const storage=await fs.mkdtemp(path.join(os.tmpdir(),'aizhushou-org-migration-'))
  t.after(()=>fs.rm(storage,{recursive:true,force:true}))
  const db=new SQL.Database()
  t.after(()=>db.close())
  db.run(`CREATE TABLE departments(id TEXT PRIMARY KEY,name TEXT,active INTEGER,updated_at TEXT);
    CREATE TABLE users(id TEXT PRIMARY KEY,employee_id TEXT UNIQUE,username TEXT UNIQUE,name TEXT,department_id TEXT,password_hash TEXT,must_change_password INTEGER,auth_version INTEGER,builtin INTEGER,active INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE user_roles(user_id TEXT,role_id TEXT,created_at TEXT,PRIMARY KEY(user_id,role_id));
    CREATE TABLE events(id INTEGER PRIMARY KEY,type TEXT,created_at TEXT,department_id TEXT,department_name TEXT);
    CREATE TABLE document_tasks(id TEXT);CREATE TABLE translations(id TEXT);`)
  db.run("INSERT INTO departments VALUES ('100','制造一厂',1,'old')")
  db.run("INSERT INTO users VALUES ('mdm:person','person','account','原姓名','100','keep-this-hash',0,7,0,1,'old','old')")
  db.run("INSERT INTO user_roles VALUES ('mdm:person','glossary_admin','old')")
  db.run("INSERT INTO events VALUES (1,'qa_click','2025-10-03T00:00:00Z','100','旧一厂名称')")
  const recorder=await createMdmSnapshotRecorder({storageDir:storage,syncId:'saved-capture',baseUrl:'http://localhost'})
  const sourceDepartments=departments.map(item=>({deptId:item.id,departmentName:item.name,companyId:item.companyId,companyIdDesc:companies.find(company=>company.id===item.companyId).name,parentDeptId:item.parentId||'-1'}))
  for(const [kind,rows] of [['department',sourceDepartments],['employee',[{employeeId:'person',code:'account',name:'接口姓名',companyId:'100',deptId:'200',deptTopId:'100'}]]])await recorder.saveResponse({kind,page:0,attempt:0,httpStatus:200,contentType:'application/json',rawBody:JSON.stringify({status:'S',totalElements:rows.length,totalPages:1,responseData:rows})})
  await recorder.completeCapture();await recorder.finish('completed')
  assert.equal((await readLatestMdmSnapshot(storage)).snapshot.departments.length,4)
  const saveDatabase=()=>fs.writeFile(path.join(storage,'aizhushou.sqlite'),Buffer.from(db.export()))
  // Production saveDatabase is synchronous; no disk writes are needed in the test callback.
  await saveDatabase()
  await createPlatform({db,saveDatabase:()=>{},session,storageDir:storage})
  const {get}=queryDb(db)
  const user=get("SELECT * FROM users WHERE id='mdm:person'")
  assert.equal(user.department_id,'200')
  assert.equal(user.company_id,'100')
  assert.equal(user.username,'account')
  assert.equal(user.name,'原姓名')
  assert.equal(user.password_hash,'keep-this-hash')
  assert.equal(user.auth_version,7)
  assert.equal(user.must_change_password,0)
  assert.equal(get("SELECT role_id FROM user_roles WHERE user_id='mdm:person'").role_id,'glossary_admin')
  assert.equal(get('SELECT department_name FROM events WHERE id=1').department_name,'旧一厂名称')
  assert.equal(get('SELECT company_id FROM events WHERE id=1').company_id,null)
  assert.equal((await fs.readdir(path.join(storage,'backups'))).length,1)
  db.run("UPDATE users SET department_id='201' WHERE id='mdm:person'")
  await createPlatform({db,saveDatabase:()=>{},session,storageDir:storage})
  assert.equal(get("SELECT department_id FROM users WHERE id='mdm:person'").department_id,'201')
})

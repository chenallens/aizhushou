import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMdmSnapshot } from '../server/mdm-normalize.js'

const departments = [
  {deptId:'company',departmentName:'总公司',companyId:'company',companyIdDesc:'总公司'},
  {deptId:'p1',departmentName:'制造一厂',parentDeptId:'company',companyId:'company'},
  {deptId:'p2',departmentName:'制造二厂',parentDeptId:'company',companyId:'company'},
  {deptId:'workshop',departmentName:'熔炼车间',parentDeptId:'p1',companyId:'company'},
]
const employee = {employeeId:'employee-first',code:'account-first',name:'测试姓名',deptId:'workshop',deptTopId:'p1'}
const normalize = (employees,options={})=>normalizeMdmSnapshot({departments,employees},{adminUsername:'admin',...options})

test('MDM record validation isolates missing identity, deduplicates and preserves names',()=>{
  const result=normalize([
    employee,{...employee},
    {employeeId:'missing-code',name:'不可登录'},
    {code:'missing-id',name:'无法关联'},
    {employeeId:'missing-name',code:'fallback-account',deptTopId:'p1'},
  ],{existingUsers:[{id:'mdm:missing-name',username:'fallback-account',name:'原有姓名'}]})
  assert.equal(result.users.length,2)
  assert.equal(result.users[1].name,'原有姓名')
  assert.equal(result.diagnostics.sourceRecords,5)
  assert.equal(result.diagnostics.skippedRecords,2)
  assert.equal(result.diagnostics.duplicateRecords,1)
  assert.equal(result.diagnostics.missingEmployeeId,1)
  assert.equal(result.diagnostics.missingAccount,1)
  assert.equal(result.diagnostics.nameFallbacks,1)
  assert.ok(!JSON.stringify(result.diagnostics).includes(employee.name))
  assert.ok(!JSON.stringify(result.diagnostics).includes(employee.code))
  assert.ok(!JSON.stringify(result.diagnostics).includes(employee.employeeId))
})

test('Shared account belonging to different people is fully quarantined',()=>{
  const result=normalize([employee,{...employee,employeeId:'other-person'},{...employee,employeeId:'valid-person',code:'valid-account'}])
  assert.deepEqual(result.users.map(item=>item.employeeId),['valid-person'])
  assert.equal(result.diagnostics.conflictingAccounts,1)
  assert.equal(result.diagnostics.skippedRecords,2)
})

test('Conflicting identity versions require an unambiguous update timestamp',()=>{
  const extra={...employee,employeeId:'valid-person',code:'valid-account'}
  const ambiguous=normalize([employee,{...employee,code:'changed-account'},extra])
  assert.equal(ambiguous.diagnostics.conflictingEmployeeIds,1)
  assert.equal(ambiguous.users.length,1)
  const dated=normalize([{...employee,lastUpdateDate:'2026-10-01T00:00:00Z'},{...employee,code:'changed-account',deptId:'p2',deptTopId:'p2',lastUpdateDate:'2026-10-02T00:00:00Z'}])
  assert.equal(dated.users[0].username,'changed-account')
  assert.equal(dated.users[0].departmentId,'p2')
  assert.equal(dated.diagnostics.duplicateRecords,1)
})

test('Real department assignment wins over auxiliary top department; complete tree retains company namespaces',()=>{
  const result=normalizeMdmSnapshot({departments:[
    {deptId:100,departmentName:'制造一厂',companyId:100,companyIdDesc:'公司甲',parentDeptId:-1},
    {deptId:200,departmentName:'设备组',companyId:100,companyIdDesc:'公司甲',parentDeptId:100},
    {deptId:201,departmentName:'设备组',companyId:100,companyIdDesc:'公司甲',parentDeptId:100},
    {deptId:300,departmentName:'制造一厂',companyId:200,companyIdDesc:'公司乙',parentDeptId:-1},
  ],employees:[{...employee,companyId:100,deptId:200,deptTopId:100}]})
  assert.equal(result.companies.length,2)
  assert.equal(result.departments.length,4)
  assert.equal(result.departments.find(item=>item.id==='100').parentId,null)
  assert.equal(result.departments.find(item=>item.id==='200').parentId,'100')
  assert.equal(result.users[0].departmentId,'200')
  assert.equal(result.users[0].companyId,'100')
  assert.equal(result.users[0].topDepartmentId,'100')
})

test('Invalid parent relationships fail atomically instead of guessing the tree',()=>{
  const base={companyId:'c',companyIdDesc:'公司',departmentName:'部门'}
  for(const nodes of [
    [{...base,deptId:'a',parentDeptId:'missing'}],
    [{...base,deptId:'a',parentDeptId:'b'},{...base,deptId:'b',parentDeptId:'a'}],
    [{...base,deptId:'a',parentDeptId:'b'},{...base,companyId:'other',deptId:'b',parentDeptId:-1}],
  ])assert.throws(()=>normalizeMdmSnapshot({departments:nodes,employees:[]}))
})

test('Partial snapshots do not reassign existing accounts to another identity',()=>{
  const result=normalize([
    {...employee,employeeId:'new-person'},
    {employeeId:'invalid-person',code:''},
    {...employee,employeeId:'valid-person',code:'valid-account'},
  ],{existingUsers:[{id:'mdm:original-person',username:employee.code,name:'原账户'}]})
  assert.deepEqual(result.users.map(item=>item.employeeId),['valid-person'])
  assert.equal(result.diagnostics.existingAccountConflicts,1)
})

test('All unusable records fail with field-specific, persistable diagnostics',()=>{
  assert.throws(()=>normalize([{employeeId:'no-code'},{code:'no-id'}]),error=>{
    assert.ok(error.message.includes('缺工号'))
    assert.equal(error.diagnostics.missingEmployeeId,1)
    assert.equal(error.diagnostics.missingAccount,1)
    assert.ok(error.diagnostics.columnNames.includes('employeeId'))
    return true
  })
})

test('Numeric zero is a valid identifier and equal department duplicates are harmless',()=>{
  const result=normalizeMdmSnapshot({departments:[...departments,departments[1]],employees:[{employeeId:0,code:0,name:'编号零',deptTopId:'p1'}]},{adminUsername:'admin'})
  assert.equal(result.users[0].employeeId,'0')
  assert.equal(result.users[0].username,'0')
  assert.equal(result.diagnostics.duplicateDepartments,1)
})

import crypto from 'node:crypto'

const identifier = value => {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return ''
}
const fingerprint = value => value ? crypto.createHash('sha256').update(value).digest('hex').slice(0,10) : null

export function normalizeMdmSnapshot(snapshot, { adminUsername, existingUsers = [] } = {}) {
  const diagnostics = {
    sourceRecords: snapshot.employees.length, acceptedRecords: 0, skippedRecords: 0,
    duplicateRecords: 0, duplicateDepartments: 0,
    missingEmployeeId: 0, missingAccount: 0, missingName: 0, nameFallbacks: 0,
    conflictingEmployeeIds: 0, conflictingAccounts: 0, existingAccountConflicts: 0,
    departmentIssues: 0, adminAccountConflicts: 0, invalidRecords: 0,
    columnNames: [], issues: [],
  }
  function issue(code,message,rowNumbers,record = {},fields = []) {
    if (diagnostics.issues.length < 30) diagnostics.issues.push({
      code, message, rowNumbers: rowNumbers.slice(0,8), fields,
      fieldTypes: Object.fromEntries(fields.map(field=>[field,record[field]===null?'null':Array.isArray(record[field])?'array':typeof record[field]])),
      employeeFingerprint: fingerprint(identifier(record.employeeId)),
      accountFingerprint: fingerprint(identifier(record.code)),
    })
  }
  function fatal(message) {
    const error = new Error(message)
    error.diagnostics = diagnostics
    throw error
  }

  const departmentMap = new Map()
  snapshot.departments.forEach((item,index) => {
    const id = identifier(item?.deptId), name = identifier(item?.departmentName)
    if (!id || !name) {
      issue('invalid_department','部门编号或名称为空',[index+1],{},['deptId','departmentName'])
      fatal(`部门第 ${index+1} 条缺少编号或名称，保留原有组织数据`)
    }
    const previous = departmentMap.get(id)
    if (previous) {
      if (identifier(previous.departmentName) !== name || identifier(previous.parentDeptId) !== identifier(item.parentDeptId) || identifier(previous.companyId)!==identifier(item.companyId)) {
        issue('conflicting_department','同一部门编号存在冲突',[index+1],{},['deptId','parentDeptId'])
        fatal(`部门第 ${index+1} 条编号存在冲突，保留原有组织数据`)
      }
      diagnostics.duplicateDepartments++
      return
    }
    departmentMap.set(id,item)
  })

  const companies = new Map(), departments = new Map(), companyRows = new Set()
  for (const [id,item] of departmentMap) {
    const companyId=identifier(item.companyId), companyName=identifier(item.companyIdDesc)
    if (!companyId) fatal('部门缺少公司编号，保留原有组织数据')
    const previous=companies.get(companyId)
    if (companyName && previous?.named && previous.name!==companyName) fatal('同一公司编号的名称存在冲突，保留原有组织数据')
    if (!previous || companyName) companies.set(companyId,{id:companyId,name:companyName||companyId,named:Boolean(companyName)})
    // Some older interfaces emit a separate company row in the department response.
    if (id===companyId && companyName===identifier(item.departmentName) && !identifier(item.parentDeptId)) companyRows.add(id)
  }
  for (const [id,item] of departmentMap) {
    if (companyRows.has(id)) continue
    const companyId=identifier(item.companyId), parent=identifier(item.parentDeptId)
    const parentId=!parent || parent==='-1' || (parent===companyId && companyRows.has(parent)) ? null : parent
    departments.set(id,{id,name:identifier(item.departmentName),companyId,parentId,level:identifier(item.deptLevel)||null})
  }
  for (const item of departments.values()) {
    let current=item
    const visited=new Set()
    while (current) {
      if (visited.has(current.id)) fatal('部门层级包含循环，保留原有组织数据')
      visited.add(current.id)
      if (!current.parentId) {item.topDepartmentId=current.id;break}
      const parent=departments.get(current.parentId)
      if (!parent || parent.companyId!==item.companyId) fatal('部门上级不存在或跨公司，保留原有组织数据')
      current=parent
    }
  }

  const groups = new Map()
  snapshot.employees.forEach((item,index) => {
    const rowNumber = index+1
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      diagnostics.invalidRecords++; diagnostics.skippedRecords++
      issue('invalid_record','人员记录不是对象',[rowNumber])
      return
    }
    diagnostics.columnNames = [...new Set([...diagnostics.columnNames,...Object.keys(item)])].slice(0,80)
    const employeeId = identifier(item.employeeId), username = identifier(item.code), name = identifier(item.name)
    if (!employeeId) diagnostics.missingEmployeeId++
    if (!username) diagnostics.missingAccount++
    if (!name) diagnostics.missingName++
    if (!employeeId || !username) {
      diagnostics.skippedRecords++
      const fields = [!employeeId?'employeeId':null,!username?'code':null].filter(Boolean)
      issue('missing_identity',`缺少${fields.map(field=>field==='code'?'工号':'人员编号').join('、')}，未创建账号`,[rowNumber],item,fields)
      return
    }
    if (username.length>200 || username.toLowerCase() === String(adminUsername||'').toLowerCase()) {
      const adminConflict = username.toLowerCase() === String(adminUsername||'').toLowerCase()
      diagnostics.skippedRecords++
      if (adminConflict) diagnostics.adminAccountConflicts++
      else diagnostics.invalidRecords++
      issue('invalid_account',adminConflict?'工号与系统管理员账号冲突':'工号长度超过账户限制',[rowNumber],item,['code'])
      return
    }
    const actualId=identifier(item.deptId) || identifier(item.deptTopId)
    const department = departments.get(actualId)
    const companyId=identifier(item.companyId)||department?.companyId||null
    if ((actualId && !department) || (companyId && !companies.has(companyId)) || (department && companyId!==department.companyId)) {
      diagnostics.skippedRecords++;diagnostics.departmentIssues++
      issue('unresolved_department','实际部门无法关联或公司归属不一致',[rowNumber],item,['deptId','companyId'])
      return
    }
    const candidate = {
      id:`mdm:${employeeId}`,employeeId,username,name,departmentId:department?.id||null,companyId,
      topDepartmentId:identifier(item.deptTopId)||department?.topDepartmentId||null,
      source:item,rows:[rowNumber],updatedAt:Date.parse(String(item.lastUpdateDate||'')),
    }
    if (!groups.has(employeeId)) groups.set(employeeId,[])
    groups.get(employeeId).push(candidate)
  })

  function mergeCompatible(versions) {
    const usernames = new Set(versions.map(item=>item.username))
    const names = new Set(versions.map(item=>item.name).filter(Boolean))
    const departments = new Set(versions.map(item=>item.departmentId).filter(Boolean))
    if (usernames.size>1 || names.size>1 || departments.size>1 || new Set(versions.map(item=>item.companyId).filter(Boolean)).size>1 || new Set(versions.map(item=>item.topDepartmentId).filter(Boolean)).size>1) return null
    return {...versions[0],name:[...names][0]||'',departmentId:[...departments][0]||null,
      companyId:versions.find(item=>item.companyId)?.companyId||null,topDepartmentId:versions.find(item=>item.topDepartmentId)?.topDepartmentId||null,
      rows:versions.flatMap(item=>item.rows)}
  }
  const candidates = []
  for (const versions of groups.values()) {
    let chosen = mergeCompatible(versions)
    if (!chosen && versions.every(item=>Number.isFinite(item.updatedAt))) {
      const newest = Math.max(...versions.map(item=>item.updatedAt))
      chosen = mergeCompatible(versions.filter(item=>item.updatedAt===newest))
      if (chosen) chosen.rows = versions.flatMap(item=>item.rows)
    }
    if (!chosen) {
      diagnostics.conflictingEmployeeIds++;diagnostics.skippedRecords+=versions.length
      issue('conflicting_employee','同一人员编号的工号、姓名或部门归属不一致，保留原账户',versions.flatMap(item=>item.rows),versions[0].source,['employeeId','code','name','deptId'])
      continue
    }
    diagnostics.duplicateRecords+=versions.length-1
    candidates.push(chosen)
  }

  const accountGroups = new Map()
  for (const item of candidates) {
    const key = item.username.toLowerCase()
    if (!accountGroups.has(key)) accountGroups.set(key,[])
    accountGroups.get(key).push(item)
  }
  const accepted = []
  for (const versions of accountGroups.values()) {
    if (versions.length>1) {
      diagnostics.conflictingAccounts++
      diagnostics.skippedRecords+=versions.reduce((sum,item)=>sum+item.rows.length,0)
      diagnostics.duplicateRecords-=versions.reduce((sum,item)=>sum+item.rows.length-1,0)
      issue('conflicting_account','同一工号对应不同人员编号，相关记录全部隔离，保留原账户',versions.flatMap(item=>item.rows),versions[0].source,['code','employeeId'])
    } else accepted.push(versions[0])
  }

  const existingById = new Map(existingUsers.map(item=>[item.id,item]))
  const existingByAccount = new Map(existingUsers.map(item=>[item.username.toLowerCase(),item]))
  const users = []
  for (const item of accepted) {
    const occupied = existingByAccount.get(item.username.toLowerCase())
    if (diagnostics.skippedRecords && occupied && occupied.id!==item.id) {
      diagnostics.existingAccountConflicts++;diagnostics.skippedRecords+=item.rows.length
      diagnostics.duplicateRecords-=item.rows.length-1
      issue('existing_account_conflict','异常快照中的工号归属与原账户不一致，保留原账户',item.rows,item.source,['code','employeeId'])
      continue
    }
    if (!item.name) {
      diagnostics.nameFallbacks++
      issue('missing_name','姓名为空，保留已有姓名或暂用工号显示',item.rows,item.source,['name'])
    }
    users.push({id:item.id,employeeId:item.employeeId,username:item.username,name:item.name||existingById.get(item.id)?.name||item.username,departmentId:item.departmentId,companyId:item.companyId,topDepartmentId:item.topDepartmentId})
  }
  diagnostics.acceptedRecords = users.length
  if (!users.length && snapshot.employees.length) fatal(`未找到可导入人员：缺人员编号 ${diagnostics.missingEmployeeId} 条、缺工号 ${diagnostics.missingAccount} 条、工号冲突 ${diagnostics.conflictingAccounts} 组。请核对 employeeId / code 字段`)
  return {companies:[...companies.values()].map(({id,name})=>({id,name})),departments:[...departments.values()],users,diagnostics}
}

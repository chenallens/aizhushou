export function organizationIndex(companies, departments, counts = []) {
  const companyMap = new Map(companies.map(item => [item.id, {...item, kind:'company', children:[], directCount:0, employeeCount:0}]))
  const departmentMap = new Map(departments.map(item => [item.id, {...item, kind:'department', children:[], directCount:0, employeeCount:0}]))
  for (const item of departmentMap.values()) {
    const parent = item.parentId ? departmentMap.get(item.parentId) : companyMap.get(item.companyId)
    if (parent) parent.children.push(item)
  }
  const sort = items => items.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN') || a.id.localeCompare(b.id))
  for (const item of [...companyMap.values(),...departmentMap.values()]) sort(item.children)
  function ancestors(item, visited = new Set()) {
    if (visited.has(item.id)) return []
    visited.add(item.id)
    const parent = departmentMap.get(item.parentId)
    return [...(parent ? ancestors(parent,visited) : []), {id:item.id,name:item.name}]
  }
  for (const item of departmentMap.values()) {
    item.ancestors = ancestors(item)
    item.path = [companyMap.get(item.companyId)?.name,...item.ancestors.map(node=>node.name)].filter(Boolean).join(' / ')
    item.ambiguous = (item.parentId ? departmentMap.get(item.parentId) : companyMap.get(item.companyId))?.children.filter(node=>node.name===item.name).length>1
  }
  for (const count of counts) {
    const item = departmentMap.get(count.departmentId)
    if (item) item.directCount += Number(count.count)
    else if (companyMap.has(count.companyId)) companyMap.get(count.companyId).directCount += Number(count.count)
  }
  function sum(item) {
    item.employeeCount = item.directCount + item.children.reduce((total,child)=>total+sum(child),0)
    item.departmentCount = item.children.reduce((total,child)=>total+1+child.departmentCount,0)
    return item.employeeCount
  }
  for (const item of companyMap.values()) sum(item)
  const descendants = id => {
    const result=[]
    const visit=item=>{if (!item) return;result.push(item.id);item.children.forEach(visit)}
    visit(departmentMap.get(id))
    return result
  }
  return {companies:[...companyMap.values()].sort((a,b)=>a.id.localeCompare(b.id,'zh-CN',{numeric:true})),departments:[...departmentMap.values()],companyMap,departmentMap,descendants}
}

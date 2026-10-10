const company = {id: '100', name: '西部超导材料科技股份有限公司'}
const companyWideDepartments = new Set(['174', '193'])

export const knowledgeAssistants = [
  {id: 'qa', title: '制造一厂知识问答AI助手', description: '知识来源为云盘内相关文档。',
    icon: 'bot', theme: 'qa', companyId: company.id, departmentId: '189'},
  {id: 'ragflow', title: '制造四厂知识问答助手', description: '知识来源为制造四厂 RAGFlow 知识库。',
    icon: 'database', theme: 'ragflow', companyId: company.id, departmentId: '192',
    companyWideAccess: [{id: '500', name: '西安聚能超导线材科技有限公司'}]},
]

export function visibleKnowledgeAssistants(user, organization) {
  if (!user) return []
  if (user.builtin && user.isSuperAdmin) return knowledgeAssistants
  const assignedCompany = organization.companyMap.get(user.companyId)
  const department = organization.departmentMap.get(user.departmentId)
  if (!assignedCompany || (department && department.companyId !== assignedCompany.id)) return []
  const ancestors = (department?.ancestors || []).map(item => organization.departmentMap.get(item.id))
  if (ancestors.some(item => !item || item.companyId !== assignedCompany.id)) return []
  const isPrimaryCompany = assignedCompany.id === company.id && assignedCompany.name === company.name
  const companyWide = isPrimaryCompany && ancestors.some(item => companyWideDepartments.has(item.id))
  return knowledgeAssistants.filter(assistant =>
    assistant.companyWideAccess?.some(audience => audience.id === assignedCompany.id && audience.name === assignedCompany.name) ||
    (isPrimaryCompany && assistant.companyId === assignedCompany.id &&
      (companyWide || ancestors.some(item => item.id === assistant.departmentId))))
}

export function publicKnowledgeAssistants(user, organization) {
  return visibleKnowledgeAssistants(user, organization).map(({id, title, description, icon, theme}) => ({id, title, description, icon, theme}))
}

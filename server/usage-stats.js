export const usageTypes = {
  qa_click: 'qaNativeUses', ragflow_click: 'ragflowUses', translation_click: 'translationUses',
  pdf_click: 'pdfUses', standard_click: 'standardUses',
}

export function shanghaiDate(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0,10)
}

export function periodBounds(period, key) {
  if (!(period === 'month' ? /^\d{4}-(0[1-9]|1[0-2])$/ : /^\d{4}$/).test(key)) throw new Error('统计周期格式不正确')
  const year = Number(key.slice(0,4))
  const month = period === 'month' ? Number(key.slice(5,7)) - 1 : 0
  if (year < 2000 || year > 2100) throw new Error('统计年份不正确')
  return {
    start: new Date(Date.UTC(year,month,1,-8)).toISOString(),
    end: new Date(Date.UTC(period === 'year' ? year + 1 : year, period === 'year' ? 0 : month + 1,1,-8)).toISOString(),
  }
}

export function createUsageStats({ all, get, run }) {
  function aggregate(period, key) {
    const range = periodBounds(period,key)
    const groups = new Map()
    for (const department of all('SELECT id, name FROM departments WHERE active = 1 ORDER BY name')) {
      groups.set(department.id, { id: department.id, name: department.name, ...emptyTotals() })
    }
    const totals = emptyTotals()
    const events = all('SELECT type, department_id, department_name FROM events WHERE created_at >= ? AND created_at < ? ORDER BY created_at, id', [range.start,range.end])
    for (const event of events) {
      const metric = usageTypes[event.type]
      if (!metric) continue
      const id = event.department_id || 'legacy'
      if (!groups.has(id)) groups.set(id, { id, name: event.department_name || '历史未归属', ...emptyTotals() })
      const group = groups.get(id)
      if (event.department_name) group.name = event.department_name
      group[metric]++
      group.total++
      totals[metric]++
      totals.total++
    }
    return { period, key, ...range, totals, departments: [...groups.values()], updatedAt: new Date().toISOString() }
  }

  function keys(period, date = new Date()) {
    const current = shanghaiDate(date)
    const earliest = get('SELECT MIN(created_at) AS first FROM events')?.first
    const start = earliest ? shanghaiDate(new Date(earliest)).slice(0, period === 'month' ? 7 : 4) : current.slice(0,period === 'month' ? 7 : 4)
    const result = []
    let key = current.slice(0,period === 'month' ? 7 : 4)
    while (key >= start && result.length < 1200) {
      result.push(key)
      key = period === 'year' ? String(Number(key) - 1) : shanghaiDate(new Date(new Date(periodBounds('month',key).start).getTime() - 1)).slice(0,7)
    }
    return result
  }

  function report(query = {}) {
    const period = query.period === 'year' ? 'year' : 'month'
    const key = String(query.key || shanghaiDate().slice(0,period === 'month' ? 7 : 4))
    periodBounds(period,key)
    if (key > shanghaiDate().slice(0,period === 'month' ? 7 : 4)) throw new Error('不能查询未来的统计周期')
    const archive = get('SELECT data_json, archived_at FROM statistics_archives WHERE period = ? AND period_key = ?', [period,key])
    const data = archive ? { ...JSON.parse(archive.data_json), archivedAt: archive.archived_at } : aggregate(period,key)
    const departmentId = String(query.departmentId || '')
    const departments = departmentId ? data.departments.filter(item=>item.id === departmentId) : data.departments
    const totals = departments.reduce((sum,item)=>{
      for (const metric of Object.keys(sum)) sum[metric] += item[metric]
      return sum
    }, emptyTotals())
    const today = shanghaiDate()
    const active = get('SELECT COUNT(*) AS count FROM events WHERE type = ? AND created_at >= ? AND created_at < ?', [
      'visit', new Date(`${today}T00:00:00+08:00`).toISOString(),new Date(new Date(`${today}T00:00:00+08:00`).getTime()+86400_000).toISOString(),
    ])?.count || 0
    return { ...data, ...totals, departments, departmentOptions: data.departments.map(({id,name})=>({id,name})), availablePeriods: keys(period), active: {day:active}, isArchived: Boolean(archive) }
  }

  function archiveDue(date = new Date()) {
    for (const period of ['month','year']) {
      for (const key of keys(period,date).slice(1)) {
        const due = new Date(periodBounds(period,key).end).getTime() + 4 * 3600_000
        if (due > date.getTime() || get('SELECT period_key FROM statistics_archives WHERE period = ? AND period_key = ?', [period,key])) continue
        run('INSERT INTO statistics_archives (period, period_key, data_json, archived_at) VALUES (?, ?, ?, ?)', [period,key,JSON.stringify(aggregate(period,key)),date.toISOString()])
      }
    }
  }
  return { report, archiveDue }
}

function emptyTotals() { return { qaNativeUses:0, ragflowUses:0, translationUses:0, pdfUses:0, standardUses:0, total:0 } }

export function createMdmClient() {
  let token = null

  function config() {
    const baseUrl = String(process.env.MDM_API_BASE_URL || 'http://daas-api.wst.com').replace(/\/+$/, '')
    const clientId = process.env.MDM_CLIENT_ID
    const clientSecret = process.env.MDM_CLIENT_SECRET
    if (!clientId || !clientSecret) throw new Error('请配置 MDM_CLIENT_ID 和 MDM_CLIENT_SECRET')
    return { baseUrl, clientId, clientSecret }
  }

  async function request(url, options) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60_000) })
      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { throw new Error('人事接口返回了非 JSON 内容') }
      return { response, data }
    } catch (error) {
      if (error.name === 'TimeoutError') throw new Error('人事接口请求超过 60 秒，请检查内网连接')
      if (error.message === 'fetch failed') throw new Error('无法连接人事接口，请检查内网连接或域名解析')
      throw error
    }
  }

  async function getToken(force = false) {
    if (!force && token?.expiresAt > Date.now()) return token.value
    const settings = config()
    const { response, data } = await request(`${settings.baseUrl}/oauth/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: settings.clientId, client_secret: settings.clientSecret }),
    })
    if (!response.ok || typeof data.access_token !== 'string') {
      throw new Error(`人事认证失败（HTTP ${response.status}），请检查客户端配置`)
    }
    token = { value: data.access_token, expiresAt: Date.now() + Math.max(1, Number(data.expires_in || 300) - 60) * 1000 }
    return token.value
  }

  async function readPages(kind, onProgress) {
    const { baseUrl } = config()
    const records = []
    let totalPages = 1
    let totalElements = null
    for (let page = 0; page < totalPages; page++) {
      let result
      for (let attempt = 0; attempt < 2; attempt++) {
        result = await request(`${baseUrl}/hitf/v2p/rest/invoke/${kind}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await getToken(attempt > 0)}` },
          body: JSON.stringify({ page, size: 200 }),
        })
        if (result.response.status !== 401 || attempt > 0) break
      }
      const { response, data } = result
      const label = kind === 'department' ? '部门' : '人员'
      if (!response.ok || data.status !== 'S') throw new Error(`人事${label}查询失败（HTTP ${response.status}，业务状态 ${String(data.status || '未知').slice(0,20)}）`)
      if (!Array.isArray(data.responseData)) throw new Error(`人事${label}接口缺少 responseData`)
      const pages = Number(data.totalPages)
      const count = Number(data.totalElements)
      if (!Number.isInteger(pages) || pages < 0 || pages > 10000 || !Number.isInteger(count) || count < 0) {
        throw new Error(`人事${label}接口分页信息不完整`)
      }
      if (page === 0) { totalPages = Math.max(1, pages); totalElements = count }
      if (count !== totalElements || Math.max(1, pages) !== totalPages || Number(data.page) !== page) {
        throw new Error(`人事${label}数据在同步期间发生变化，请重新同步`)
      }
      records.push(...data.responseData)
      onProgress?.({ kind, page: page + 1, totalPages, received: records.length, totalElements })
    }
    if (records.length !== totalElements) throw new Error(`人事${kind === 'department' ? '部门' : '人员'}分页数量不一致，保留原有数据`)
    return records
  }

  return {
    async readSnapshot(onProgress) {
      return { departments: await readPages('department', onProgress), employees: await readPages('employee', onProgress) }
    },
  }
}

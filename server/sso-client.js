export class SsoError extends Error {
  constructor(code,message,status=400) {super(message);this.code=code;this.status=status}
}
const unsafeCharacters=value=>/\s/u.test(value)||[...value].some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127)

export function createSsoClient(env=process.env) {
  const enabled=String(env.SSO_ENABLED||'true').toLowerCase()==='true'
  const checkTicketUrl=env.SSO_CHECK_TICKET_URL||'http://192.168.50.87:8888/sso/checkTicket'
  const forbiddenUrl=env.SSO_FORBIDDEN_URL||'http://192.168.50.87:8888/403'
  const timeoutMs=Math.min(60_000,Math.max(100,Number(env.SSO_TIMEOUT_MS)||15_000))
  function httpUrl(value) {
    const url=new URL(value)
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)throw new Error('Invalid SSO URL')
    return url
  }
  const deniedUrl=httpUrl(forbiddenUrl).toString()
  async function checkTicket(ticket) {
    if(!enabled)throw new SsoError('SSO_DISABLED','门户登录暂未启用，请使用本平台账号登录',503)
    if(typeof ticket!=='string'||!ticket||Buffer.byteLength(ticket,'utf8')>4096||unsafeCharacters(ticket))throw new SsoError('SSO_INVALID_TICKET','缺少或无效的登录凭证，请从门户重新进入')
    let url
    try {url=httpUrl(checkTicketUrl)} catch {throw new SsoError('SSO_CONFIGURATION','门户登录配置不正确，请联系管理员',503)}
    url.searchParams.set('ticket',ticket)
    const controller=new AbortController()
    const timer=setTimeout(()=>controller.abort(),timeoutMs)
    try {
      const response=await fetch(url,{redirect:'manual',signal:controller.signal,headers:{Accept:'application/json'}})
      if(!response.ok)throw new SsoError('SSO_UPSTREAM_HTTP','门户认证服务暂不可用，请稍后从门户重新进入',502)
      if(!response.body)throw new SsoError('SSO_INVALID_RESPONSE','门户认证返回格式不正确，请联系管理员',502)
      const chunks=[];let length=0
      for await(const chunk of response.body) {
        length+=chunk.byteLength
        if(length>64*1024)throw new SsoError('SSO_INVALID_RESPONSE','门户认证返回格式不正确，请联系管理员',502)
        chunks.push(chunk)
      }
      let body
      try {body=JSON.parse(Buffer.concat(chunks).toString('utf8'))} catch {throw new SsoError('SSO_INVALID_RESPONSE','门户认证返回格式不正确，请联系管理员',502)}
      // The supplied portal protocol permits a data-only response; explicit failures never authenticate.
      if(!body||typeof body!=='object'||Array.isArray(body)||(Object.hasOwn(body,'code')&&body.code!==200&&body.code!=='200')||body.success===false||body.error)throw new SsoError('SSO_REJECTED','登录凭证已失效，请从门户重新进入',401)
      if(typeof body.data!=='string')throw new SsoError('SSO_INVALID_RESPONSE','门户认证未返回有效账号，请联系管理员',502)
      const username=body.data.trim()
      if(!username||username.length>200||unsafeCharacters(username))throw new SsoError('SSO_INVALID_RESPONSE','门户认证未返回有效账号，请联系管理员',502)
      return username
    } catch(error) {
      if(error instanceof SsoError)throw error
      if(controller.signal.aborted)throw new SsoError('SSO_TIMEOUT','门户认证连接超时，请稍后从门户重新进入',504)
      throw new SsoError('SSO_UNREACHABLE','无法连接门户认证服务，请联系管理员检查内网连接',502)
    } finally {clearTimeout(timer)}
  }
  return {checkTicket,forbiddenUrl:deniedUrl}
}

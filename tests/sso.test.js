import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {createSsoClient} from '../server/sso-client.js'

test('Portal protocol: data-only or explicit success, URL encoding and fail-closed responses',async(t)=>{
  let requests=0
  const fixture=http.createServer((req,res)=>{
    requests++
    const ticket=new URL(req.url,'http://localhost').searchParams.get('ticket')
    if(ticket==='redirect'){res.writeHead(302,{Location:'/unsafe'});res.end();return}
    if(ticket==='http-error'){res.writeHead(503);res.end('unavailable');return}
    if(ticket==='slow'){setTimeout(()=>res.end(JSON.stringify({data:'wst2821'})),220);return}
    if(ticket==='slow-body'){res.writeHead(200,{'Content-Type':'application/json'});res.flushHeaders();setTimeout(()=>res.end(JSON.stringify({data:'wst2821'})),220);return}
    const values={
      'valid':{code:200,msg:'ok',data:'wst2821'},'data-only':{data:'wst2821'},
      'string-code':{code:'200',data:'wst2821'},'bad-code':{code:500,data:'wst2821'},
      'bad-success':{success:false,data:'wst2821'},'bad-error':{data:'wst2821',error:'failure'},
      'null-data':{code:200,data:null},'object-data':{code:200,data:{username:'wst2821'}},
      'space-account':{data:'wst 2821'},'control-account':{data:'wst\u00002821'},
      'empty-data':{data:''},'large':'x'.repeat(70*1024),'html':'<!doctype html>',
    }
    const value=values[ticket]
    if(value!==undefined)res.end(typeof value==='string'?value:JSON.stringify(value))
    else {assert.equal(ticket,'a+b&c=?/%');res.end(JSON.stringify({data:'wst2821'}))}
  })
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve))
  t.after(async()=>{fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve))})
  const url=`http://127.0.0.1:${fixture.address().port}/sso/checkTicket`
  const client=createSsoClient({SSO_CHECK_TICKET_URL:url})
  for(const ticket of ['valid','data-only','string-code','a+b&c=?/%'])assert.equal(await client.checkTicket(ticket),'wst2821')
  for(const ticket of ['bad-code','bad-success','bad-error','null-data','object-data','space-account','control-account','empty-data','large','html','redirect','http-error'])await assert.rejects(client.checkTicket(ticket),error=>error.code.startsWith('SSO_'))
  const before=requests
  for(const ticket of ['',null,[],{},'white space','nul\u0000','x'.repeat(4097)])await assert.rejects(client.checkTicket(ticket),error=>error.code==='SSO_INVALID_TICKET')
  assert.equal(requests,before)
  const timed=createSsoClient({SSO_CHECK_TICKET_URL:url,SSO_TIMEOUT_MS:'100'})
  for(const ticket of ['slow','slow-body'])await assert.rejects(timed.checkTicket(ticket),error=>error.code==='SSO_TIMEOUT')
  await assert.rejects(createSsoClient({SSO_ENABLED:'false',SSO_CHECK_TICKET_URL:url}).checkTicket('valid'),error=>error.code==='SSO_DISABLED')
  await assert.rejects(createSsoClient({SSO_CHECK_TICKET_URL:'file:///secrets'}).checkTicket('valid'),error=>error.code==='SSO_CONFIGURATION')
})

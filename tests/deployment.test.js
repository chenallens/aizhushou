import test from 'node:test'
import assert from 'node:assert/strict'
import dotenv from 'dotenv'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const {mergeConfiguration}=require('../deploy/import-env.cjs')

test('Server configuration import preserves credentials and new defaults, with lossless quoting',()=>{
  const current={ADMIN_PASSWORD:'new-password',MDM_CLIENT_ID:'new-client',MDM_CLIENT_SECRET:'new-secret',SSO_ENABLED:'true',SSO_CHECK_TICKET_URL:'http://portal/sso/checkTicket',SESSION_SECRET:'change-this-session-secret',STORAGE_DIR:'E:/development'}
  const previous={ADMIN_PASSWORD:'old # secret',QA_AUTH_CLIENT_SECRET:'quoted "value" and \\n',RAGFLOW_API_KEY:"value'with\nnewline",MOCK_AI:'true',SERVER_PORT:'4321',PLATFORM_SCHEDULER_DISABLED:'true'}
  const result=dotenv.parse(mergeConfiguration(current,previous))
  assert.equal(result.ADMIN_PASSWORD,previous.ADMIN_PASSWORD)
  assert.equal(result.QA_AUTH_CLIENT_SECRET,previous.QA_AUTH_CLIENT_SECRET)
  assert.equal(result.RAGFLOW_API_KEY,previous.RAGFLOW_API_KEY)
  assert.equal(result.MDM_CLIENT_SECRET,current.MDM_CLIENT_SECRET)
  assert.equal(result.SSO_ENABLED,'true')
  assert.equal(result.SERVER_PORT,'4178')
  assert.equal(result.MOCK_AI,'false')
  assert.equal(result.STORAGE_DIR,undefined)
  assert.equal(result.PLATFORM_SCHEDULER_DISABLED,undefined)
  assert.match(result.SESSION_SECRET,/^[a-f0-9]{64}$/)
  assert.throws(()=>mergeConfiguration(current,{STORAGE_DIR:'D:/external-data'}),/custom STORAGE_DIR/)
  assert.throws(()=>mergeConfiguration(current,{secret:'all\'`"quotes'}),/quote combinations/)
})

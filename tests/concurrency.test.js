import test from 'node:test'
import assert from 'node:assert/strict'
import {setTimeout as sleep} from 'node:timers/promises'
import {concurrencyOptions,mapOrdered,createLimiter,retryableModelError,validateConcurrencySettings} from '../server/concurrency.js'

test('Concurrency defaults, serial overrides and invalid values are bounded',()=>{
  assert.deepEqual(concurrencyOptions({}),{translation:2,layout:2,requests:2,retries:1,retryDelay:1000})
  assert.equal(concurrencyOptions({TRANSLATION_CHUNK_CONCURRENCY:'1',DOCUMENT_LAYOUT_CONCURRENCY:'1',AI_DOCUMENT_MAX_CONCURRENCY:'1'}).translation,1)
  assert.equal(concurrencyOptions({TRANSLATION_CHUNK_CONCURRENCY:'1000',AI_DOCUMENT_MAX_CONCURRENCY:'1000',AI_DOCUMENT_RETRY_COUNT:'-1'}).requests,2)
  assert.equal(concurrencyOptions({AI_DOCUMENT_RETRY_COUNT:'0'}).retries,0)
  assert.equal(retryableModelError(Object.assign(new Error('temporary'),{status:503})),true)
  assert.equal(retryableModelError(Object.assign(new Error('unauthorized'),{status:401})),false)
  assert.equal(retryableModelError(new TypeError('programming mistake')),false)
  assert.equal(retryableModelError(new TypeError('fetch failed')),true)
})
test('Bounded workers overlap, return input order and support serial mode',async()=>{
  let active=0,maximum=0;const finished=[]
  const result=await mapOrdered([60,5,10],2,async(delay,index)=>{
    active++;maximum=Math.max(active,maximum);await sleep(delay);active--;finished.push(index);return index
  })
  assert.equal(maximum,2);assert.deepEqual(result,[0,1,2]);assert.notDeepEqual(finished,[0,1,2])
  active=0;maximum=0
  await mapOrdered([1,2,3],1,async()=>{active++;maximum=Math.max(active,maximum);await sleep(5);active--})
  assert.equal(maximum,1)
})
test('Fatal workers cancel peers, stop new work and settle before returning failure',async()=>{
  const started=[],finished=[]
  await assert.rejects(mapOrdered([1,2,3],2,async(_item,index,signal)=>{
    started.push(index)
    try {if(index===0){await sleep(15);throw new Error('fatal fixture')}await sleep(300,undefined,{signal})}
    finally {finished.push(index)}
  }),/fatal fixture/)
  assert.deepEqual(started,[0,1]);assert.equal(finished.length,2);await sleep(30);assert.equal(finished.length,2)
})
test('Shared request limiter is FIFO, abortable and releases slots after errors',async()=>{
  const limiter=createLimiter(1),order=[],controller=new AbortController()
  let release;const hold=new Promise(resolve=>release=resolve)
  const first=limiter.run(async()=>{order.push(1);await hold;throw new Error('first failed')})
  const failedFirst=assert.rejects(first,/first failed/)
  const cancelled=limiter.run(async()=>order.push(2),controller.signal),rejected=assert.rejects(cancelled,/cancelled fixture/)
  const third=limiter.run(async()=>order.push(3))
  controller.abort(new Error('cancelled fixture'));release()
  await failedFirst;await rejected;await third
  assert.deepEqual(order,[1,3])
  assert.equal(await limiter.run(async()=>7),7)
})
test('Administrator values are strictly validated and raising a live limit admits queued work',async()=>{
  assert.deepEqual(validateConcurrencySettings({translation:1,layout:2,requests:3,retries:0}),{translation:1,layout:2,requests:3,retries:0})
  assert.throws(()=>validateConcurrencySettings({translation:2,layout:2,requests:9,retries:1}),/允许范围/)
  assert.throws(()=>validateConcurrencySettings({translation:2,layout:2,requests:2,retries:1,extra:1}),/格式/)
  const limiter=createLimiter(1),order=[]
  let release;const hold=new Promise(resolve=>release=resolve)
  const first=limiter.run(async()=>{order.push(1);await hold}),second=limiter.run(async()=>order.push(2))
  await sleep(10);assert.deepEqual(order,[1]);assert.equal(limiter.state().waiting,1)
  limiter.setLimit(2);await second;assert.deepEqual(order,[1,2]);release();await first
  assert.equal(limiter.state().active,0)
})

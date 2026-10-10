function integer(value,fallback,max) {
  const number=Number(value)
  return Number.isInteger(number)&&number>=1&&number<=max?number:fallback
}

export function concurrencyOptions(env=process.env) {
  const retries=Number(env.AI_DOCUMENT_RETRY_COUNT??1)
  return {
    translation:integer(env.TRANSLATION_CHUNK_CONCURRENCY,2,4),
    layout:integer(env.DOCUMENT_LAYOUT_CONCURRENCY,2,4),
    requests:integer(env.AI_DOCUMENT_MAX_CONCURRENCY,2,8),
    retries:Number.isInteger(retries)&&retries>=0&&retries<=2?retries:1,
    retryDelay:integer(env.AI_DOCUMENT_RETRY_DELAY_MS,1000,30000),
  }
}

export function validateConcurrencySettings(value) {
  const ranges={translation:[1,4],layout:[1,4],requests:[1,8],retries:[0,2]}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!Object.hasOwn(ranges,key)))throw Object.assign(new Error('并发设置格式不正确'),{status:400})
  for(const[key,[min,max]]of Object.entries(ranges))if(!Number.isInteger(value[key])||value[key]<min||value[key]>max)throw Object.assign(new Error('并发数或重试次数超出允许范围'),{status:400})
  return Object.fromEntries(Object.keys(ranges).map(key=>[key,value[key]]))
}

// Workers finish in any order, but the caller receives the original item order.
export async function mapOrdered(items,limit,worker) {
  const results=new Array(items.length),controller=new AbortController()
  let cursor=0,failure
  async function run() {
    while(!failure&&cursor<items.length) {
      const index=cursor++
      try {results[index]=await worker(items[index],index,controller.signal)}
      catch(error) {if(!failure){failure=error instanceof Error?error:new Error(String(error));controller.abort(failure)}}
    }
  }
  await Promise.all(Array.from({length:Math.min(integer(limit,1,8),items.length)},run))
  if(failure)throw failure
  return results
}

export function createLimiter(limit) {
  let maximum=integer(limit,1,8)
  const waiting=[]
  let active=0
  function drain() {
    while(active<maximum&&waiting.length) {
      const job=waiting.shift()
      job.signal?.removeEventListener('abort',job.cancel)
      if(job.signal?.aborted){job.reject(job.signal.reason);continue}
      active++
      job.resolve()
    }
  }
  return {
    state:()=>({active,waiting:waiting.length,limit:maximum}),
    setLimit(value){maximum=integer(value,1,8);drain()},
    async run(operation,signal) {
      signal?.throwIfAborted()
      await new Promise((resolve,reject)=>{
        const job={resolve,reject,signal,cancel:()=>{
          const index=waiting.indexOf(job)
          if(index>=0)waiting.splice(index,1)
          reject(signal.reason)
        }}
        signal?.addEventListener('abort',job.cancel,{once:true})
        waiting.push(job);drain()
      })
      try {signal?.throwIfAborted();return await operation()}
      finally {active--;drain()}
    },
  }
}

export function retryableModelError(error) {
  return [408,429,500,502,503,504].includes(error?.status)||
    error?.name==='TimeoutError'||(error?.name==='TypeError'&&error.message==='fetch failed')||
    ['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(error?.cause?.code)
}

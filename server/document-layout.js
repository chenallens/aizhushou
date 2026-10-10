import fs from 'node:fs/promises'
import {Marked} from 'marked'
import {parse} from 'node-html-parser'
import {Document,Packer,Paragraph,TextRun,Table,TableRow,TableCell,HeadingLevel,WidthType,BorderStyle,ExternalHyperlink,LevelFormat,AlignmentType} from 'docx'

const markdown=new Marked({gfm:true,breaks:true})
const tags=['h1','h2','h3','h4','h5','h6','p','br','strong','b','em','i','u','s','del','code','pre','blockquote','ul','ol','li','table','thead','tbody','tfoot','tr','th','td','a','hr']
const headings=[HeadingLevel.HEADING_1,HeadingLevel.HEADING_2,HeadingLevel.HEADING_3,HeadingLevel.HEADING_4,HeadingLevel.HEADING_5,HeadingLevel.HEADING_6]
const allowedTags=new Set(tags)
const nonTextTags=new Set(['script','style','iframe','svg','math','textarea','xmp','plaintext','template','object','embed'])
const escapeHtml=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')

export function documentHtml(source) {
  const root=parse(markdown.parse(String(source||'')))
  function safeNode(node) {
    const name=String(node.tagName||'').toLowerCase()
    if(!name)return node.nodeType===3?escapeHtml(node.text):''
    if(nonTextTags.has(name))return ''
    const children=node.childNodes.map(safeNode).join('')
    if(!allowedTags.has(name))return children
    if(name==='br'||name==='hr')return `<${name}>`
    let attributes=''
    if(name==='a') {
      try {
        const href=node.getAttribute('href')||'',target=new URL(href,'http://preview.invalid')
        if(href&&!href.startsWith('//')&&['http:','https:','mailto:'].includes(target.protocol)) {
          const value=/^(https?:|mailto:)/i.test(href)?target.href:/^(\/|#)/.test(href)?href:''
          if(value)attributes=` href="${escapeHtml(value)}" target="_blank" rel="noopener noreferrer"`
        }
      } catch {}
    } else if(name==='td'||name==='th') {
      const span=Math.min(32,Math.max(1,Number.parseInt(node.getAttribute('colspan'),10)||1))
      if(span>1)attributes=` colspan="${span}"`
    } else if(name==='ol') {
      const start=Number.parseInt(node.getAttribute('start'),10)
      if(start>0&&start<=1000000)attributes=` start="${start}"`
    }
    return `<${name}${attributes}>${children}</${name}>`
  }
  return root.childNodes.map(safeNode).join('')
}

export function layoutContentMatches(source,candidate) {
  const fingerprint=value=>parse(documentHtml(value)).structuredText.replace(/\s/g,'')
  const links=value=>parse(documentHtml(value)).querySelectorAll('a').map(item=>item.getAttribute('href')||'')
  const tables=value=>parse(documentHtml(value)).querySelectorAll('table').map(table=>table.querySelectorAll('tr').filter(row=>row.closest('table')===table).map(row=>row.childNodes.filter(cell=>['TH','TD'].includes(cell.tagName)).map(cell=>cell.structuredText.replace(/\s/g,''))))
  const originalTables=tables(source)
  return fingerprint(source)===fingerprint(candidate)&&JSON.stringify(links(source))===JSON.stringify(links(candidate))&&
    (!originalTables.length||JSON.stringify(originalTables)===JSON.stringify(tables(candidate)))
}

export function markdownDocumentChunks(source,limit=12000) {
  const input=String(source||'').replace(/\r\n?/g,'\n'),tokens=markdown.lexer(input)
  if(tokens.map(token=>token.raw||'').join('')!==input)return [input.trim()]
  const chunks=[];let pending=''
  for(const token of tokens) {
    const block=token.raw||''
    if(pending&&pending.length+block.length>limit){chunks.push(pending.trim());pending=''}
    pending+=block
    if(pending.length>=limit){chunks.push(pending.trim());pending=''}
  }
  if(pending.trim())chunks.push(pending.trim())
  return chunks.length?chunks:['']
}

export async function createFormattedDocument({source,outputPath,onLayoutProgress,onGenerate}) {
  const html=documentHtml(source),root=parse(html),numbering=[]
  let tableCount=0
  const tag=node=>String(node.tagName||'').toLowerCase()
  const base={font:'Microsoft YaHei',color:'000000',size:22}
  function inline(nodes,style={}) {
    return nodes.flatMap(node=>{
      const name=tag(node)
      if(!name)return [new TextRun({...base,...style,text:node.text||''})]
      if(name==='br')return [new TextRun({...base,...style,break:1})]
      const childStyle={...style,...(['strong','b'].includes(name)?{bold:true}:{}),...(['em','i'].includes(name)?{italics:true}:{}),...(['s','del'].includes(name)?{strike:true}:{}),...(name==='u'?{underline:{}}:{}),...(name==='code'?{font:'Consolas',size:20}:{})}
      const runs=inline(node.childNodes,childStyle)
      if(name==='p')runs.push(new TextRun({...base,...style,break:1}))
      const href=node.getAttribute('href')
      return name==='a'&&href&&/^(https?:|mailto:)/i.test(href)?[new ExternalHyperlink({link:href,children:runs})]:runs
    })
  }
  function paragraph(node,properties={}) {
    const name=tag(node),level=/^h[1-6]$/.test(name)?Number(name[1]):0
    return new Paragraph({children:inline(node.childNodes,level?{bold:true,size:[32,28,25,23,22,22][level-1]}:{}),
      ...(level?{heading:headings[level-1],keepNext:true}:{}),spacing:{before:level?200:0,after:140,line:300},...properties})
  }
  function list(node,depth=0) {
    const ordered=tag(node)==='ol',reference=`list-${numbering.length}`
    if(ordered)numbering.push({reference,levels:[{level:0,format:LevelFormat.DECIMAL,text:'%1.',start:Number(node.getAttribute('start'))||1,alignment:AlignmentType.START,style:{paragraph:{indent:{left:720+depth*360,hanging:300}}}}]})
    return node.childNodes.filter(child=>tag(child)==='li').flatMap(item=>{
      const content=item.childNodes.filter(child=>!['ul','ol'].includes(tag(child)))
      const result=[new Paragraph({children:inline(content),...(ordered?{numbering:{reference,level:0}}:{bullet:{level:Math.min(depth,8)}}),spacing:{after:100,line:300}})]
      for(const nested of item.childNodes.filter(child=>['ul','ol'].includes(tag(child))))result.push(...list(nested,depth+1))
      return result
    })
  }
  function table(node) {
    const rows=node.querySelectorAll('tr').filter(row=>row.closest('table')===node)
    const cells=row=>row.childNodes.filter(child=>['th','td'].includes(tag(child)))
    const span=cell=>Math.min(32,Math.max(1,Number.parseInt(cell.getAttribute('colspan'),10)||1))
    const width=Math.max(1,...rows.map(row=>cells(row).reduce((count,cell)=>count+span(cell),0)))
    if(!rows.length)return new Paragraph('')
    tableCount++
    const border={style:BorderStyle.SINGLE,size:4,color:'C9D4DF'}
    return new Table({width:{size:100,type:WidthType.PERCENTAGE},borders:{top:border,bottom:border,left:border,right:border,insideHorizontal:border,insideVertical:border},
      rows:rows.map(row=>{
        const sourceCells=cells(row),header=sourceCells.some(cell=>tag(cell)==='th')
        const result=sourceCells.map(cell=>new TableCell({columnSpan:span(cell),width:{size:100*span(cell)/width,type:WidthType.PERCENTAGE},
          margins:{top:100,bottom:100,left:100,right:100},...(header?{shading:{fill:'F1F5F9'}}:{}),
          children:[new Paragraph({children:inline(cell.childNodes,{size:20,...(header?{bold:true}:{})}),spacing:{after:60,line:260}})]}))
        const occupied=sourceCells.reduce((count,cell)=>count+span(cell),0)
        for(let index=occupied;index<width;index++)result.push(new TableCell({children:[new Paragraph('')]}))
        return new TableRow({...header?{tableHeader:true}:{},children:result})
      })})
  }
  function block(node) {
    const name=tag(node)
    if(!name)return node.text?.trim()?[new Paragraph({children:inline([node])})]:[]
    if(name==='table')return [table(node)]
    if(['ul','ol'].includes(name))return list(node)
    if(name==='blockquote')return node.childNodes.flatMap(child=>block(child))
    if(name==='pre')return [new Paragraph({children:node.structuredText.split('\n').flatMap((line,index)=>[new TextRun({...base,font:'Consolas',size:20,text:line,...(index?{break:1}:{})})]),spacing:{after:160}})]
    if(name==='hr')return [new Paragraph({border:{bottom:{style:BorderStyle.SINGLE,size:4,color:'C9D4DF'}},spacing:{before:120,after:160}})]
    return [paragraph(node)]
  }
  const nodes=root.childNodes.filter(node=>tag(node)||node.text?.trim()),children=[]
  for(const [index,node]of nodes.entries()) {
    children.push(...block(node))
    await onLayoutProgress?.({completed:index+1,total:nodes.length,tables:tableCount})
    if(index%8===0)await new Promise(resolve=>setImmediate(resolve))
  }
  await onGenerate?.()
  const wide=root.querySelectorAll('tr').some(row=>row.querySelectorAll('th,td').length>=7)
  const doc=new Document({styles:{default:{document:{run:base}}},numbering:{config:numbering},sections:[{properties:{page:{size:{width:wide?16838:11906,height:wide?11906:16838},margin:{top:1134,right:1134,bottom:1134,left:1134}}},children:children.length?children:[new Paragraph('')]}]})
  await fs.writeFile(outputPath,await Packer.toBuffer(doc))
  return {html:`<div class="formattedDocument">${html}</div>`,tables:tableCount,blocks:nodes.length}
}

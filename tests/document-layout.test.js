import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import mammoth from 'mammoth'
import {parse} from 'node-html-parser'
import {documentHtml,layoutContentMatches,markdownDocumentChunks,createFormattedDocument} from '../server/document-layout.js'

const source='# 检查单\n\n正文 **重点**。\n\n| 项目 | 要求 | 备注 |\n| --- | --- | --- |\n| 压力 | ≥ 5 MPa<br>复验 | |\n| A\\|B | C:\\\\Audit\\\\2026 | 1.2 |\n\n1. 第一步\n2. 第二步\n'
test('Formatted preview is sanitized and preserves headings, empty cells, pipes and cell line breaks',()=>{
  const root=parse(documentHtml(source+'\n<script>alert(1)</script><img src="https://external.test/tracker" onerror="alert(2)"><a href="javascript:alert(3)" onclick="alert(4)">链接</a>'))
  assert.equal(root.querySelectorAll('h1').length,1);assert.equal(root.querySelectorAll('table').length,1)
  assert.equal(root.querySelectorAll('tr').length,3);assert.equal(root.querySelectorAll('tbody tr')[0].querySelectorAll('td').length,3)
  assert.ok(root.structuredText.includes('A|B'));assert.ok(root.querySelector('tbody').innerHTML.includes('<br'))
  assert.equal(root.querySelectorAll('script,img').length,0)
  assert.ok(!root.toString().includes('javascript:'));assert.ok(!root.toString().includes('onclick'))
})
test('Model layout validation rejects modified numbers, wording, cell positions and URLs',()=>{
  assert.equal(layoutContentMatches(source,source.replace('# 检查单','## 检查单')),true)
  assert.equal(layoutContentMatches(source,source.replace('5 MPa','50 MPa')),false)
  assert.equal(layoutContentMatches(source,source.replace('复验','放行')),false)
  assert.equal(layoutContentMatches('| A | B |\n|---|---|\n| 1 | 2 |','| A | B | C |\n|---|---|---|\n| 1 | | 2 |'),false)
  assert.equal(layoutContentMatches('[规范](https://a.test)','[规范](https://b.test)'),false)
})
test('Markdown chunking never splits a table or discards reference definitions',()=>{
  const table='| A | B |\n|---|---|\n'+Array.from({length:30},(_,index)=>`| ${index} | 项目 |`).join('\n')
  const chunks=markdownDocumentChunks('# 标题\n\n'+table+'\n\n结束',60)
  assert.ok(chunks.some(chunk=>chunk.includes(table)));assert.equal(layoutContentMatches('# 标题\n\n'+table+'\n\n结束',chunks.join('\n\n')),true)
  const reference='[来源][spec]\n\n[spec]: https://a.test';assert.equal(layoutContentMatches(reference,markdownDocumentChunks(reference,10).join('\n\n')),true)
})
test('DOCX export creates editable native tables matching the preview and reports layout/generation stages',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aizhushou-layout-')),outputPath=path.join(directory,'result.docx'),progress=[]
  const result=await createFormattedDocument({source,outputPath,onLayoutProgress:event=>progress.push(event),onGenerate:()=>progress.push({generating:true})})
  assert.equal(result.tables,1);assert.ok(result.blocks>=3);assert.equal(progress.at(-1).generating,true)
  const converted=await mammoth.convertToHtml({buffer:await fs.readFile(outputPath)}),root=parse(converted.value)
  assert.equal(root.querySelectorAll('table').length,1);assert.equal(root.querySelectorAll('tr').length,3)
  assert.equal(root.querySelectorAll('td,th').length,9);assert.ok(root.structuredText.includes('A|B'))
  assert.ok(root.structuredText.includes('C:\\Audit\\2026'));assert.ok(root.structuredText.includes('≥ 5 MPa'))
})

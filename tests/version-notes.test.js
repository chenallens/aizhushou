import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import crypto from 'node:crypto'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import initSqlJs from 'sql.js'
import express from 'express'
import {createVersionNotes} from '../server/version-notes.js'

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const project = process.env.VERSION_NOTES_TEST_APP_DIR || source
const runtime = process.env.VERSION_NOTES_TEST_NODE || process.execPath
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

test('Version publish/delete persistence failures restore metadata, audit and file access', async t => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'version-notes-write-'))
  const SQL = await initSqlJs(), db = new SQL.Database()
  db.run('CREATE TABLE administration_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT,action TEXT,target_id TEXT,details_json TEXT,created_at TEXT)')
  let failSave = false
  const notes = createVersionNotes({db, storageDir: storage, decodeFilename: value => value, saveDatabase: () => {if (failSave) throw new Error('simulated disk failure')}})
  await notes.ready
  const app = express()
  app.use((req, _res, next) => {req.user = {id: 'super', isSuperAdmin: true}; next()})
  notes.registerRoutes(app, {requireUser: (_req, _res, next) => next()})
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({error: error.message}))
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); await fs.rm(storage, {recursive: true, force: true})})
  const origin = 'http://127.0.0.1:' + server.address().port, pdf = await fs.readFile(path.join(source, 'tests', 'fixtures', 'layout-source.pdf'))
  const upload = () => {const body = new FormData(); body.append('version', 'v1'); body.append('file', new Blob([pdf]), 'guide.pdf'); return fetch(origin + '/api/admin/version-notes', {method: 'POST', body})}
  const count = table => db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0]
  failSave = true
  assert.equal((await upload()).status, 500); assert.equal(count('version_notes'), 0); assert.equal(count('administration_audit'), 0)
  assert.deepEqual(await fs.readdir(path.join(storage, 'version-notes')), [])
  failSave = false
  const accepted = await upload(); assert.equal(accepted.status, 201); const row = (await accepted.json()).item
  failSave = true
  assert.equal((await fetch(origin + '/api/admin/version-notes/' + row.id, {method: 'DELETE'})).status, 500)
  assert.equal((await fetch(origin + row.previewUrl)).status, 200); assert.equal(count('administration_audit'), 1)
  assert.equal((await fs.readdir(path.join(storage, 'version-notes'))).length, 1)
  failSave = false
  assert.equal((await fetch(origin + '/api/admin/version-notes/' + row.id, {method: 'DELETE'})).status, 200)
  assert.equal((await fetch(origin + row.previewUrl)).status, 404); assert.equal(count('administration_audit'), 2)
})

test('Version notes are public, safely stored, paginated and managed only by super admins', {timeout: 60000}, async t => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'aizhushou-versions-'))
  const SQL = await initSqlJs(), db = new SQL.Database()
  db.run('CREATE TABLE users(id TEXT PRIMARY KEY,employee_id TEXT UNIQUE,username TEXT UNIQUE,name TEXT,department_id TEXT,company_id TEXT,password_hash TEXT,must_change_password INTEGER DEFAULT 0,auth_version INTEGER DEFAULT 1,builtin INTEGER DEFAULT 0,active INTEGER DEFAULT 1,created_at TEXT,updated_at TEXT); CREATE TABLE user_roles(user_id TEXT,role_id TEXT,created_at TEXT,PRIMARY KEY(user_id,role_id));')
  const hash = 'version-salt:' + crypto.scryptSync('version-test-password', 'version-salt', 32).toString('hex')
  for (const id of ['ordinary', 'terms']) db.run('INSERT INTO users(id,employee_id,username,name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', [id, id, id, '测试' + id, hash, 'old', 'old'])
  db.run("INSERT INTO user_roles VALUES('terms','glossary_admin','old')")
  await fs.writeFile(path.join(storage, 'aizhushou.sqlite'), Buffer.from(db.export())); db.close()
  const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve))
  const origin = 'http://127.0.0.1:' + port
  let child, logs = ''
  async function start() {
    child = spawn(runtime, ['server/index.js'], {cwd: project, windowsHide: true, env: {...process.env, SERVER_PORT: String(port), STORAGE_DIR: storage, MOCK_AI: 'true', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'version-test-admin', SESSION_SECRET: 'version-test-session', PLATFORM_SCHEDULER_DISABLED: 'true'}})
    child.stdout.on('data', piece => logs += piece); child.stderr.on('data', piece => logs += piece)
    for (let tries = 0; tries < 1000; tries++) {
      if (child.exitCode !== null) throw new Error(logs)
      try {if ((await fetch(origin + '/api/health')).ok) return} catch {}
      await pause(25)
    }
    throw new Error('Server did not start: ' + logs)
  }
  async function stop() {if (child && child.exitCode === null) {child.kill(); await new Promise(resolve => child.once('exit', resolve))}}
  t.after(async () => {await stop(); await fs.rm(storage, {recursive: true, force: true})})
  await start()
  async function login(username, password) {
    const response = await fetch(origin + '/api/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username, password})})
    assert.equal(response.status, 200)
    return response.headers.getSetCookie()[0].split(';')[0]
  }
  const admin = await login('admin', 'version-test-admin'), ordinary = await login('ordinary', 'version-test-password'), terms = await login('terms', 'version-test-password')
  const pdf = await fs.readFile(path.join(source, 'tests', 'fixtures', 'layout-source.pdf'))
  const files = () => fs.readdir(path.join(storage, 'version-notes'))
  async function api(url, {cookie = '', method = 'GET', body, expected = 200} = {}) {
    const response = await fetch(origin + url, {method, headers: {Cookie: cookie}, body})
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data
  }
  function form(version = 'v1.0', buffer = pdf, name = 'AI助手使用说明（测试）.pdf') {
    const body = new FormData(); if (version !== null) body.append('version', version)
    if (buffer !== null) body.append('file', new Blob([buffer], {type: 'application/pdf'}), name)
    return body
  }
  const upload = (version, expected = 201, buffer, name) => api('/api/admin/version-notes', {cookie: admin, method: 'POST', body: form(version, buffer, name), expected})
  let records
  await t.test('Anonymous reading is allowed, but uploads/deletes are guarded before any disk writes', async () => {
    const empty = await api('/api/version-notes'); assert.equal(empty.total, 0); assert.equal(empty.pageSize, 3); assert.equal(empty.page, 1)
    for (const [cookie, expected] of [['', 401], [ordinary, 403], [terms, 403]]) {
      await api('/api/admin/version-notes', {cookie, method: 'POST', body: form(), expected})
      await api('/api/admin/version-notes/1', {cookie, method: 'DELETE', expected})
    }
    assert.deepEqual(await files(), [])
    await api('/api/version-notes/1/pdf', {expected: 404})
    await api('/api/translation/terminology-source.pdf', {expected: 401})
  })
  await t.test('Invalid forms and forged PDF content fail and leave no files', async () => {
    for (const version of ['', ' '.repeat(5), 'a'.repeat(41), 'bad\nversion', null]) await upload(version, 400)
    await upload('valid', 400, null)
    await upload('valid', 400, Buffer.from('<!DOCTYPE html><h1>not PDF</h1>'))
    await upload('valid', 400, Buffer.from('%PDF-1.7\ncorrupted\n%%EOF'))
    await upload('valid', 400, pdf, 'file.docx')
    const extra = form(); extra.append('unexpected', 'x')
    await api('/api/admin/version-notes', {cookie: admin, method: 'POST', body: extra, expected: 400})
    const multiple = form(); multiple.append('file', new Blob([pdf]), 'second.pdf')
    await api('/api/admin/version-notes', {cookie: admin, method: 'POST', body: multiple, expected: 400})
    assert.deepEqual(await files(), []); assert.equal((await api('/api/version-notes')).total, 0)
  })
  await t.test('Seven records keep original names, allow identical versions without overwriting, and page newest first', async () => {
    records = []
    for (let index = 1; index <= 7; index++) records.push((await upload(index <= 2 ? 'v1.0' : 'v1.' + index)).item)
    assert.equal((await files()).length, 7)
    assert.equal(records[0].originalName, 'AI助手使用说明（测试）.pdf')
    assert.equal(records[0].fileSize, pdf.length)
    for (const [page, indexes] of [[1, [6, 5, 4]], [2, [3, 2, 1]], [3, [0]]]) {
      const data = await api('/api/version-notes?page=' + page)
      assert.deepEqual(data.items.map(row => row.id), indexes.map(index => records[index].id))
      assert.equal(data.total, 7); assert.equal(data.totalPages, 3); assert.equal(data.latestId, records[6].id)
      assert.ok(!JSON.stringify(data).includes(storage)); assert.ok(!JSON.stringify(data).includes('storedName'))
    }
    assert.equal((await api('/api/version-notes?page=999')).page, 3)
    for (const page of ['-1', 'x', '1.5', 'Infinity']) assert.equal((await api('/api/version-notes?page=' + page)).page, 1)
  })
  await t.test('PDF previews are public, inline, Chinese-named and support byte ranges', async () => {
    const full = await fetch(origin + records[6].previewUrl)
    assert.equal(full.status, 200); assert.equal(full.headers.get('Content-Type'), 'application/pdf')
    assert.ok(full.headers.get('Content-Disposition').startsWith('inline;'))
    assert.ok(decodeURIComponent(full.headers.get('Content-Disposition')).includes(records[6].originalName))
    assert.equal(full.headers.get('X-Content-Type-Options'), 'nosniff'); assert.equal(full.headers.get('Cache-Control'), 'no-store')
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), pdf)
    const range = await fetch(origin + records[6].previewUrl, {headers: {Range: 'bytes=0-31'}})
    assert.equal(range.status, 206); assert.equal(range.headers.get('Content-Range'), `bytes 0-31/${pdf.length}`)
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), pdf.subarray(0, 32))
    for (const id of ['-1', '99999', '1e3', 'abc']) await api('/api/version-notes/' + id + '/pdf', {expected: 404})
  })
  await t.test('Restart preserves manual files and records, and copied storage survives upgrade', async () => {
    await stop(); await start()
    assert.equal((await api('/api/version-notes')).total, 7)
    assert.equal((await fetch(origin + records[0].previewUrl)).status, 200)
    assert.equal((await files()).length, 7)
    // Moving the whole storage is the documented Windows upgrade path.
    const moved = path.join(storage, 'copied-storage')
    await fs.cp(path.join(storage, 'version-notes'), path.join(moved, 'version-notes'), {recursive: true})
    await fs.copyFile(path.join(storage, 'aizhushou.sqlite'), path.join(moved, 'aizhushou.sqlite'))
    const copied = new SQL.Database(await fs.readFile(path.join(moved, 'aizhushou.sqlite')))
    assert.equal(copied.exec('SELECT COUNT(*) FROM version_notes WHERE deleted_at IS NULL')[0].values[0][0], 7); copied.close()
    assert.equal((await fs.readdir(path.join(moved, 'version-notes'))).length, 7)
  })
  await t.test('Deleting the last row on a page clamps pagination, revokes previews and audits all changes', async () => {
    const first = records[0]
    await api('/api/admin/version-notes/' + first.id, {cookie: admin, method: 'DELETE'})
    await api(first.previewUrl, {expected: 404})
    await api('/api/admin/version-notes/' + first.id, {cookie: admin, method: 'DELETE', expected: 404})
    const clamped = await api('/api/version-notes?page=3'); assert.equal(clamped.page, 2); assert.equal(clamped.total, 6)
    assert.equal((await files()).length, 6)
    for (const row of records.slice(1)) await api('/api/admin/version-notes/' + row.id, {cookie: admin, method: 'DELETE'})
    const empty = await api('/api/version-notes?page=3'); assert.equal(empty.total, 0); assert.equal(empty.page, 1); assert.equal(empty.latestId, null)
    assert.deepEqual(await files(), [])
    const audit = (await api('/api/admin/operations', {cookie: admin})).items
    assert.equal(audit.filter(row => row.action === 'version_notes.publish').length, 7)
    assert.equal(audit.filter(row => row.action === 'version_notes.delete').length, 7)
    await stop(); await start()
    await api(first.previewUrl, {expected: 404}); assert.equal((await api('/api/version-notes')).total, 0)
  })
})

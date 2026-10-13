import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import multer from 'multer'
import {PDFParse} from 'pdf-parse'

export const manualFileLimit = 200 * 1024 * 1024
const pageSize = 3
const failure = (message, status = 400) => Object.assign(new Error(message), {status})
const hasControls = value => [...value].some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)
const select = 'SELECT id,version,original_name AS originalName,file_size AS fileSize,created_at AS createdAt FROM version_notes WHERE deleted_at IS NULL'

export function createVersionNotes({db, saveDatabase, storageDir, decodeFilename}) {
  const directory = path.join(storageDir, 'version-notes')
  fs.mkdirSync(directory, {recursive: true})
  db.run(`CREATE TABLE IF NOT EXISTS version_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL, original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE, file_size INTEGER NOT NULL, created_by TEXT NOT NULL,
    created_at TEXT NOT NULL, deleted_at TEXT
  ); CREATE INDEX IF NOT EXISTS version_notes_order ON version_notes(deleted_at,created_at DESC,id DESC);`)
  saveDatabase()
  function all(sql, values = []) {
    const stmt = db.prepare(sql)
    try {stmt.bind(values); const items = []; while (stmt.step()) items.push(stmt.getAsObject()); return items}
    finally {stmt.free()}
  }
  const get = (sql, values) => all(sql, values)[0]
  const filePath = name => {
    if (!/^[0-9a-f-]{36}\.pdf$/.test(name)) throw failure('使用说明文件记录异常', 500)
    return path.join(directory, name)
  }
  const item = row => ({...row, previewUrl: `/api/version-notes/${row.id}/pdf`})
  function list(query = {}) {
    const total = get('SELECT COUNT(*) AS total FROM version_notes WHERE deleted_at IS NULL').total
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const requested = Number(query.page)
    const page = Math.min(totalPages, Number.isSafeInteger(requested) && requested > 0 ? requested : 1)
    const latestId = get(`${select} ORDER BY created_at DESC,id DESC LIMIT 1`)?.id || null
    return {items: all(`${select} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`, [pageSize, (page - 1) * pageSize]).map(item), total, page, pageSize, totalPages, latestId, maxFileSize: manualFileLimit}
  }
  function persist(change) {
    let undo
    db.run('BEGIN TRANSACTION')
    try {undo = change(); db.run('COMMIT')}
    catch (error) {db.run('ROLLBACK'); throw error}
    try {saveDatabase()}
    catch (error) {
      db.run('BEGIN TRANSACTION')
      try {undo(); db.run('COMMIT')}
      catch (restoreError) {db.run('ROLLBACK'); throw restoreError}
      throw error
    }
  }
  function audit(user, action, id, details) {
    db.run('INSERT INTO administration_audit(actor_id,action,target_id,details_json,created_at) VALUES(?,?,?,?,?)', [user.id, `version_notes.${action}`, String(id), JSON.stringify(details), new Date().toISOString()])
    return get('SELECT last_insert_rowid() AS id').id
  }
  async function removeFile(name) {
    try {await fsp.unlink(filePath(name)); return true}
    catch (error) {
      if (error.code === 'ENOENT') return true
      console.warn('[version-notes] 文件清理暂未完成:', error.code)
      return false
    }
  }
  // Windows may keep an open PDF handle; tombstones revoke access before disk cleanup.
  async function cleanDeleted() {
    for (const row of all('SELECT stored_name AS storedName FROM version_notes WHERE deleted_at IS NOT NULL')) await removeFile(row.storedName)
  }
  const ready = cleanDeleted()
  const upload = multer({
    storage: multer.diskStorage({destination: directory, filename: (_req, _file, done) => done(null, `${crypto.randomUUID()}.pdf`)}),
    limits: {fileSize: manualFileLimit, files: 1, fields: 1, fieldSize: 256, parts: 3},
    fileFilter: (_req, file, done) => {
      const name = decodeFilename(file.originalname).replace(/\\/g, '/').split('/').pop().trim()
      if (!name || name.length > 240 || hasControls(name) || path.extname(name).toLowerCase() !== '.pdf') return done(failure('请上传 PDF 格式的使用说明，文件名不超过 240 个字符'))
      file.originalname = name
      done(null, true)
    },
  }).single('file')
  const receiveUpload = (req, res, next) => upload(req, res, error => {
    if (!error) return next()
    if (error instanceof multer.MulterError) return next(failure(error.code === 'LIMIT_FILE_SIZE' ? '使用说明 PDF 不能超过 200 MB' : '请只上传一个 PDF 文件并填写版本号', error.code === 'LIMIT_FILE_SIZE' ? 413 : 400))
    next(error)
  })
  function registerRoutes(app, platform) {
    const manage = (req, res, next) => platform.requireUser(req, res, () => {
      if (!req.user.isSuperAdmin) return res.status(403).json({error: '仅超级管理员可发布或删除版本说明'})
      next()
    })
    app.get('/api/version-notes', (_req, res) => res.set('Cache-Control', 'no-store').json(list(_req.query)))
    app.get('/api/version-notes/:id/pdf', (req, res, next) => {
      const id = Number(req.params.id)
      const row = Number.isSafeInteger(id) && id > 0 ? get('SELECT stored_name AS storedName,original_name AS originalName FROM version_notes WHERE id=? AND deleted_at IS NULL', [id]) : null
      if (!row) return res.status(404).json({error: '版本说明不存在或已删除'})
      const filename = encodeURIComponent(row.originalName).replace(/['()*]/g, value => '%' + value.charCodeAt(0).toString(16).toUpperCase())
      res.type('application/pdf').set({'Content-Disposition': `inline; filename="user-guide.pdf"; filename*=UTF-8''${filename}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'})
      res.sendFile(filePath(row.storedName), error => {if (error && !res.headersSent) next(failure('使用说明文件暂不可用，请联系管理员', error.status || 500))})
    })
    app.post('/api/admin/version-notes', manage, receiveUpload, async (req, res, next) => {
      let saved = false
      try {
        if (!req.file) throw failure('请选择使用说明 PDF')
        const version = typeof req.body.version === 'string' ? req.body.version.trim() : ''
        if (!version || [...version].length > 40 || hasControls(version)) throw failure('请填写 1 至 40 个字符的版本号')
        const buffer = await fsp.readFile(req.file.path)
        if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw failure('文件内容不是有效的 PDF，请重新选择')
        const parser = new PDFParse({data: buffer})
        try {const info = await parser.getInfo(); if (!info.total) throw new Error('empty')}
        catch {throw failure('PDF 无法读取，请上传无需密码且完整的 PDF 文件')}
        finally {await parser.destroy()}
        let id
        persist(() => {
          db.run('INSERT INTO version_notes(version,original_name,stored_name,file_size,created_by,created_at) VALUES(?,?,?,?,?,?)', [version, req.file.originalname, req.file.filename, req.file.size, req.user.id, new Date().toISOString()])
          id = get('SELECT last_insert_rowid() AS id').id
          const auditId = audit(req.user, 'publish', id, {version, originalName: req.file.originalname})
          return () => {db.run('DELETE FROM version_notes WHERE id=?', [id]); db.run('DELETE FROM administration_audit WHERE id=?', [auditId])}
        })
        saved = true
        res.status(201).json({ok: true, item: item(get(`${select} AND id=?`, [id]))})
      } catch (error) {
        if (req.file && !saved) await removeFile(req.file.filename)
        next(error)
      }
    })
    app.delete('/api/admin/version-notes/:id', manage, async (req, res, next) => {
      try {
        const id = Number(req.params.id)
        const row = Number.isSafeInteger(id) && id > 0 ? get('SELECT id,version,original_name AS originalName,stored_name AS storedName FROM version_notes WHERE id=? AND deleted_at IS NULL', [id]) : null
        if (!row) throw failure('版本说明不存在或已删除', 404)
        persist(() => {
          db.run('UPDATE version_notes SET deleted_at=? WHERE id=?', [new Date().toISOString(), id])
          const auditId = audit(req.user, 'delete', id, {version: row.version, originalName: row.originalName})
          return () => {db.run('UPDATE version_notes SET deleted_at=NULL WHERE id=?', [id]); db.run('DELETE FROM administration_audit WHERE id=?', [auditId])}
        })
        const removed = await removeFile(row.storedName)
        res.json({ok: true, ...(!removed ? {warning: '版本说明已删除，文件被占用，将在下次服务启动时再次清理'} : {})})
      } catch (error) {next(error)}
    })
  }
  return {registerRoutes, ready}
}

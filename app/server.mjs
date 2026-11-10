/**
 * 课程助手 · 本地服务
 * 轮询 B 站课程窗口 → 分类 → 抓弹幕/评论 → 生成知识地图 → 出 Word
 * 页面：http://127.0.0.1:<port>
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { createStore } from '../plugins/dsh-video-coursemap/lib/core/store.mjs'
import { createAgent } from '../plugins/dsh-video-coursemap/lib/core/pipeline.mjs'
import { initPollScript, readForeground } from '../plugins/dsh-video-coursemap/lib/core/poll.mjs'
import { cleanTitle, isBrowserProc } from '../plugins/dsh-video-coursemap/lib/core/title.mjs'
import { createOpenAILLM } from './summarizer/openai.mjs'
import { createNotesOps } from './notes-ops.mjs'

const APP_DIR = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(APP_DIR, 'config.json')
const RUNTIME_PATH = join(APP_DIR, 'runtime.json')
const UI_DIR = join(APP_DIR, 'ui')

const DEFAULTS = {
  port: 3456,
  pollIntervalMs: 10000,
  stablePolls: 2,
  titleMinLen: 4,
  enabled: true,
  fetchContent: true,
  maxTokens: 4096,
  outputDir: join(homedir(), '课程知识地图'),
  llm: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: '' },
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

function writeJsonAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp.' + process.pid
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

function loadConfig() {
  const raw = readJson(CONFIG_PATH, null)
  const cfg = { ...DEFAULTS, ...(raw || {}), llm: { ...DEFAULTS.llm, ...(raw?.llm || {}) } }
  return cfg
}

function validatePatch(patch) {
  const errors = []
  const next = {}
  if (patch.pollIntervalMs !== undefined) {
    const v = Number(patch.pollIntervalMs)
    if (!Number.isFinite(v) || v < 2000 || v > 300000) errors.push('轮询间隔需在 2000–300000 毫秒之间')
    else next.pollIntervalMs = Math.round(v)
  }
  if (patch.stablePolls !== undefined) {
    const v = Number(patch.stablePolls)
    if (!Number.isInteger(v) || v < 1 || v > 10) errors.push('稳定次数需为 1–10 的整数')
    else next.stablePolls = v
  }
  if (patch.titleMinLen !== undefined) {
    const v = Number(patch.titleMinLen)
    if (!Number.isInteger(v) || v < 1 || v > 40) errors.push('标题最小长度需为 1–40 的整数')
    else next.titleMinLen = v
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') errors.push('enabled 必须是布尔值')
    else next.enabled = patch.enabled
  }
  if (patch.fetchContent !== undefined) {
    if (typeof patch.fetchContent !== 'boolean') errors.push('fetchContent 必须是布尔值')
    else next.fetchContent = patch.fetchContent
  }
  if (patch.maxTokens !== undefined) {
    const v = Number(patch.maxTokens)
    if (!Number.isInteger(v) || v < 256 || v > 8192) errors.push('maxTokens 需为 256–8192 的整数')
    else next.maxTokens = v
  }
  if (patch.llm !== undefined) {
    if (!patch.llm || typeof patch.llm !== 'object') errors.push('llm 必须是对象')
    else {
      const llm = {}
      if (patch.llm.baseUrl !== undefined) {
        const u = String(patch.llm.baseUrl).trim()
        if (!/^https?:\/\//i.test(u)) errors.push('baseUrl 需要以 http(s):// 开头')
        else llm.baseUrl = u.replace(/\/+$/, '')
      }
      if (patch.llm.model !== undefined) {
        const m = String(patch.llm.model).trim()
        if (!m) errors.push('model 不能为空')
        else llm.model = m
      }
      if (patch.llm.apiKey !== undefined) llm.apiKey = String(patch.llm.apiKey).trim()
      next.llm = llm
    }
  }
  return { errors, next }
}

let config = loadConfig()
const outputDir = resolve(config.outputDir)
if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })
const store = createStore({ outputDir, owner: 'app' })
const notesOps = createNotesOps({ store })
initPollScript(store.stateDir)

function logDelete(kind, subject, detail) {
  try { store.log('deleted ' + kind + ' subject=' + JSON.stringify(subject) + ' detail=' + JSON.stringify(detail)) } catch { /* 忽略 */ }
}

// ---- 模型 + 流水线（配置变更时重建） ----
let llm = createOpenAILLM(config.llm)
let agent = null
let tickTimer = null
let nextTickAt = 0
let startedAt = Date.now()
const events = []
const sseClients = new Set()

function buildAgent() {
  llm = createOpenAILLM(config.llm)
  agent = createAgent({
    store,
    llm,
    config: {
      stablePolls: config.stablePolls,
      titleMinLen: config.titleMinLen,
      fetchContent: config.fetchContent,
      maxTokens: config.maxTokens,
      llmConfigured: Boolean(config.llm.apiKey),
    },
    emit: pushEvent,
  })
}

const LOGGED = new Set(['tick', 'decision', 'classify', 'fetch', 'generate-done', 'error', 'skipped'])
function logEvent(e) {
  if (!LOGGED.has(e.type)) return
  const detail = e.type === 'tick'
    ? `fg proc=${e.proc} title=${JSON.stringify(e.title)}`
    : e.type === 'decision'
      ? `verdict=${e.verdict} cleaned=${JSON.stringify(e.cleaned ?? '')}`
      : e.type === 'classify'
        ? `classify title=${JSON.stringify(e.title)} subject=${e.subject} isCourse=${e.isCourse}`
        : e.type === 'fetch'
          ? `bili bvid=${e.bvid ?? 'none'} danmaku=${e.danmaku} comments=${e.comments}`
          : e.type === 'generate-done'
            ? `done subject=${e.subject} title=${JSON.stringify(e.title)} docx=${e.docxOk ? 'ok' : 'failed'}`
            : e.type === 'skipped'
              ? `skipped reason=${e.reason} lock=${JSON.stringify(e.lock ?? {})}`
              : `error code=${e.code} msg=${e.message}`
  try { store.log(detail) } catch { /* 忽略 */ }
}

function pushEvent(event) {
  const e = { id: events.length + 1, at: Date.now(), ...event }
  logEvent(e)
  events.push(e)
  if (events.length > 300) events.splice(0, events.length - 300)
  const payload = 'data: ' + JSON.stringify(e) + '\n\n'
  for (const res of sseClients) {
    try { res.write(payload) } catch { sseClients.delete(res) }
  }
}

function schedule() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
  nextTickAt = 0
  if (!config.enabled) return
  nextTickAt = Date.now() + config.pollIntervalMs
  tickTimer = setInterval(async () => {
    nextTickAt = Date.now() + config.pollIntervalMs
    try { await agent.observe() } catch (e) { pushEvent({ type: 'error', code: 'TICK_FAILED', message: e.message }) }
  }, config.pollIntervalMs)
}

buildAgent()
schedule()

const heartbeat = setInterval(() => store.touchLock(), 10000)
store.acquireLock()

function statusPayload() {
  const subjects = store.subjectsList()
  const st = store.readState()
  const docs = []
  for (const s of subjects) {
    const docx = store.manualDocxPath(s.subject)
    docs.push({
      subject: s.subject,
      videos: s.videos,
      docx: existsSync(docx) ? docx : null,
      docxAt: store.docxMtime(docx) || null,
      hasMd: existsSync(store.manualMdPath(s.subject)),
    })
  }
  const indexDocx = store.indexDocxPath()
  return {
    ok: true,
    pid: process.pid,
    startedAt,
    enabled: config.enabled,
    intervalMs: config.pollIntervalMs,
    stablePolls: config.stablePolls,
    titleMinLen: config.titleMinLen,
    fetchContent: config.fetchContent,
    nextTickAt,
    outputDir,
    subjects,
    docs,
    indexDocx: existsSync(indexDocx) ? indexDocx : null,
    lastTitle: st.lastTitle,
    lastRunAt: st.lastRunAt,
    llm: {
      configured: Boolean(config.llm.apiKey),
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      keyHint: config.llm.apiKey ? '****' + config.llm.apiKey.slice(-4) : '',
    },
    lock: store.lockInfo(),
    busy: agent ? agent.busy : false,
  }
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 1_000_000) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolvePromise({})
      try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('JSON 解析失败')) }
    })
    req.on('error', reject)
  })
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '')
  const full = resolve(UI_DIR, rel)
  if (!full.startsWith(resolve(UI_DIR) + sep) && full !== resolve(UI_DIR, 'index.html')) {
    res.writeHead(403); res.end('forbidden'); return
  }
  if (!existsSync(full)) { res.writeHead(404); res.end('not found'); return }
  const ext = full.slice(full.lastIndexOf('.'))
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(full))
}

function openTarget(p) {
  const full = resolve(p)
  if (!full.startsWith(outputDir + sep) && full !== outputDir) throw new Error('只允许打开输出目录内的文件')
  if (!existsSync(full)) throw new Error('路径不存在：' + full)
  spawn('explorer.exe', [full], { detached: true, stdio: 'ignore' }).unref()
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const path = url.pathname
  try {
    if (req.method === 'GET' && path === '/api/status') return sendJson(res, 200, statusPayload())

    if (req.method === 'GET' && path === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      for (const e of events.slice(-100)) res.write('data: ' + JSON.stringify(e) + '\n\n')
      sseClients.add(res)
      const ping = setInterval(() => { try { res.write(': ping\n\n') } catch { /* 忽略 */ } }, 15000)
      req.on('close', () => { clearInterval(ping); sseClients.delete(res) })
      return
    }

    if (req.method === 'POST' && path === '/api/config') {
      const body = await readBody(req)
      const { errors, next } = validatePatch(body)
      if (errors.length) return sendJson(res, 400, { ok: false, errors })
      const before = { intervalMs: config.pollIntervalMs, enabled: config.enabled, outputDir: resolve(config.outputDir) }
      config = { ...config, ...next, llm: { ...config.llm, ...(next.llm || {}) } }
      writeJsonAtomic(CONFIG_PATH, config)
      if (before.intervalMs !== config.pollIntervalMs || before.enabled !== config.enabled) {
        buildAgent()
        schedule()
      }
      if (next.llm || before.outputDir !== resolve(config.outputDir)) buildAgent()
      pushEvent({ type: 'status', ...statusPayload() })
      return sendJson(res, 200, { ok: true, status: statusPayload() })
    }

    if (req.method === 'POST' && path === '/api/scan') {
      const body = await readBody(req)
      let title = typeof body.title === 'string' && body.title.trim() ? cleanTitle(body.title) : ''
      if (!title) {
        const fg = await readForeground()
        if (!fg) return sendJson(res, 503, { ok: false, message: '读不到前台窗口' })
        title = cleanTitle(fg.title)
        if (!isBrowserProc(fg.proc)) {
          return sendJson(res, 400, { ok: false, message: `前台窗口不是浏览器/视频客户端（进程 ${fg.proc || '未知'}）` })
        }
      }
      if (!title) return sendJson(res, 400, { ok: false, message: '标题为空' })
      agent.processTitle(title).catch((e) => pushEvent({ type: 'error', code: 'SCAN_FAILED', message: e.message }))
      return sendJson(res, 200, { ok: true, message: '已开始处理「' + title + '」' })
    }

    if (req.method === 'GET' && path === '/api/notes') {
      return sendJson(res, 200, { ok: true, docs: statusPayload().docs, indexDocx: statusPayload().indexDocx })
    }

    if (path.startsWith('/api/notes/')) {
      const rest = decodeURIComponent(path.slice('/api/notes/'.length))
      const [subject, action] = rest.split('/')
      const mdPath = store.manualMdPath(subject)

      if (req.method === 'GET' && !action) {
        if (!existsSync(mdPath)) return sendJson(res, 404, { ok: false, message: '没有该学科的 Markdown 源' })
        return sendJson(res, 200, {
          ok: true, subject,
          markdown: readFileSync(mdPath, 'utf8'),
          videos: notesOps.listVideos(subject),
          docx: existsSync(store.manualDocxPath(subject)) ? store.manualDocxPath(subject) : null,
        })
      }

      if (req.method === 'POST' && action === 'rebuild') {
        try {
          const rebuilt = notesOps.rebuildSubject(subject)
          notesOps.rebuildIndex()
          return sendJson(res, 200, { ok: true, rebuilt })
        } catch (e) {
          return sendJson(res, 400, { ok: false, message: e.message })
        }
      }

      if (req.method === 'POST' && action === 'delete-video') {
        const body = await readBody(req)
        if (typeof body.title !== 'string' || !body.title.trim()) return sendJson(res, 400, { ok: false, message: '缺少 title' })
        try {
          const r = notesOps.deleteVideo(subject, body.title.trim(), { keepSeen: body.keepSeen === true })
          logDelete('video', subject, body.title.trim())
          return sendJson(res, 200, { ok: true, removed: r.removed, status: statusPayload() })
        } catch (e) {
          return sendJson(res, 400, { ok: false, message: e.message })
        }
      }

      if ((req.method === 'POST' && action === 'delete') || (req.method === 'DELETE' && !action)) {
        const body = req.method === 'DELETE' ? {} : await readBody(req)
        try {
          const r = notesOps.deleteSubject(subject, { keepSeen: body.keepSeen === true })
          logDelete('subject', subject, r.videos + ' 个视频')
          return sendJson(res, 200, { ok: true, videos: r.videos, status: statusPayload() })
        } catch (e) {
          return sendJson(res, 400, { ok: false, message: e.message })
        }
      }
    }

    if (req.method === 'POST' && path === '/api/rebuild') {
      try {
        const r = notesOps.rebuildAll()
        return sendJson(res, 200, { ok: true, ...r })
      } catch (e) {
        return sendJson(res, 400, { ok: false, message: e.message })
      }
    }

    if (req.method === 'GET' && path === '/api/log') {
      const tail = Number(url.searchParams.get('tail') || 200)
      return sendJson(res, 200, { ok: true, lines: store.readLog(Number.isFinite(tail) ? tail : 200) })
    }

    if (req.method === 'POST' && path === '/api/open') {
      const body = await readBody(req)
      if (typeof body.path !== 'string' || !body.path.trim()) return sendJson(res, 400, { ok: false, message: '缺少 path' })
      try { openTarget(body.path) } catch (e) { return sendJson(res, 400, { ok: false, message: e.message }) }
      return sendJson(res, 200, { ok: true })
    }

    if (req.method === 'POST' && path === '/api/llm/test') {
      const body = await readBody(req)
      const probe = createOpenAILLM({ ...config.llm, ...(body.llm || {}) })
      try {
        const text = await probe.complete({
          system: '只回复两个字：可用',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          maxTokens: 16,
        })
        return sendJson(res, 200, { ok: true, reply: String(text).slice(0, 40) })
      } catch (e) {
        return sendJson(res, 400, { ok: false, code: e.code || 'LLM_ERROR', message: e.message })
      }
    }

    if (req.method === 'POST' && path === '/api/seen/reset') {
      store.resetSeen()
      return sendJson(res, 200, { ok: true })
    }

    if (req.method === 'POST' && path === '/api/shutdown') {
      sendJson(res, 200, { ok: true })
      shutdown('api')
      return
    }

    if (req.method === 'GET' && !path.startsWith('/api/')) return serveStatic(res, path)

    return sendJson(res, 404, { ok: false, message: 'not found' })
  } catch (e) {
    return sendJson(res, 500, { ok: false, message: e.message })
  }
})

function listen(port, attempt = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 3) {
      listen(port + 1, attempt + 1)
      return
    }
    console.error('[课程助手] 启动失败：', e.message)
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    writeJsonAtomic(RUNTIME_PATH, { port, pid: process.pid, startedAt, url: `http://127.0.0.1:${port}` })
    console.log(`[课程助手] 已启动 http://127.0.0.1:${port}  输出目录 ${outputDir}`)
  })
}

let shuttingDown = false
function shutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  console.log('[课程助手] 正在退出：' + reason)
  if (tickTimer) clearInterval(tickTimer)
  clearInterval(heartbeat)
  store.releaseLock()
  for (const c of sseClients) { try { c.end() } catch { /* 忽略 */ } }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 800)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('exit', () => store.releaseLock())

listen(config.port)

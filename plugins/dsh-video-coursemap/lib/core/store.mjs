/** 知识地图的落盘状态：state.json / manuals/*.md / docx 产出 + 进程锁。 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, statSync,
} from 'node:fs'
import { join } from 'node:path'

const SEEN_LIMIT = 500
const LOCK_TTL_MS = 30000

function ensureDir(p) { if (!existsSync(p)) mkdirSync(p, { recursive: true }) }

function atomicWrite(file, content) {
  ensureDir(join(file, '..'))
  const tmp = `${file}.tmp.${process.pid}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

export function createStore({ outputDir, owner = 'unknown' }) {
  const stateDir = join(outputDir, '.state')
  const manualsDir = join(stateDir, 'manuals')
  const statePath = join(stateDir, 'state.json')
  const logPath = join(stateDir, 'poll.log')
  const lockPath = join(stateDir, 'lock.json')
  ensureDir(stateDir)
  ensureDir(manualsDir)

  function readState() {
    try {
      const j = JSON.parse(readFileSync(statePath, 'utf8'))
      if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('bad state')
      if (!j.subjects || typeof j.subjects !== 'object') j.subjects = {}
      if (!j.seen || typeof j.seen !== 'object') j.seen = {}
      if (typeof j.lastTitle !== 'string') j.lastTitle = ''
      if (typeof j.lastRunAt !== 'number') j.lastRunAt = 0
      return j
    } catch {
      return { subjects: {}, seen: {}, lastTitle: '', lastRunAt: 0 }
    }
  }

  function writeState(s) { atomicWrite(statePath, JSON.stringify(s, null, 2) + '\n') }

  /** 读改写：每次变更前重读磁盘，避免与其他实例互相覆盖。 */
  function mutate(fn) {
    const s = readState()
    const ret = fn(s)
    writeState(s)
    return ret
  }

  function log(line) {
    try { appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8') } catch { /* 忽略 */ }
  }

  function readLog(tail = 200) {
    try {
      const lines = readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean)
      return lines.slice(-tail)
    } catch { return [] }
  }

  function pruneSeen(s) {
    const keys = Object.keys(s.seen)
    if (keys.length <= SEEN_LIMIT) return
    keys.sort((a, b) => (s.seen[a] ?? 0) - (s.seen[b] ?? 0))
    for (const k of keys.slice(0, keys.length - SEEN_LIMIT)) delete s.seen[k]
  }

  const isSeen = (title) => Object.hasOwn(readState().seen, title)

  function markSeen(title) {
    mutate((s) => {
      s.seen[title] = Date.now()
      s.lastTitle = title
      pruneSeen(s)
    })
  }

  function markRun(title) {
    mutate((s) => {
      s.seen[title] = Date.now()
      s.lastTitle = title
      s.lastRunAt = Date.now()
      pruneSeen(s)
    })
  }

  function resetSeen() { mutate((s) => { s.seen = {} }) }

  const subjectsList = () => Object.entries(readState().subjects).map(([subject, d]) => ({
    subject,
    videos: d?.videos?.length ?? 0,
    createdAt: d?.createdAt ?? 0,
  }))

  const subjectDir = (subject) => join(outputDir, subject)
  const manualMdPath = (subject) => join(manualsDir, `${subject}.md`)
  const manualDocxPath = (subject) => join(subjectDir(subject), '学习手册.docx')
  const indexMdPath = () => join(manualsDir, 'index.md')
  const indexDocxPath = () => join(outputDir, '课程总览.docx')

  function buildOverviewBlock(subject, s) {
    const videos = s.subjects[subject]?.videos ?? []
    const lines = ['```mermaid', 'mindmap', `  root((${subject}))`]
    for (const v of videos) lines.push(`    ${String(v).replace(/[()[\]{}|<>'`\\/]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)}`)
    lines.push('```')
    return `<!-- OVERVIEW_START -->\n## 学科总览\n${lines.join('\n')}\n<!-- OVERVIEW_END -->`
  }

  function createSubjectManual(subject) {
    const fence = ['```mermaid', 'mindmap', '  root((' + subject + '))', '```'].join('\n')
    const header = `# ${subject} 学习手册\n\n<!-- OVERVIEW_START -->\n## 学科总览\n${fence}\n<!-- OVERVIEW_END -->\n`
    atomicWrite(manualMdPath(subject), header)
  }

  function appendVideo(subject, md) {
    const p = manualMdPath(subject)
    const prev = existsSync(p) ? readFileSync(p, 'utf8') : `# ${subject} 学习手册\n`
    atomicWrite(p, prev.replace(/\s+$/, '') + `\n\n---\n\n${md}\n`)
  }

  function regenerateOverview(subject) {
    const s = readState()
    const p = manualMdPath(subject)
    if (!existsSync(p)) return
    const text = readFileSync(p, 'utf8')
    const start = text.indexOf('<!-- OVERVIEW_START -->')
    const end = text.indexOf('<!-- OVERVIEW_END -->')
    if (start === -1 || end === -1) return
    atomicWrite(p, text.slice(0, start) + buildOverviewBlock(subject, s) + text.slice(end + '<!-- OVERVIEW_END -->'.length))
  }

  function addSubjectVideo(subject, title) {
    mutate((s) => {
      if (!s.subjects[subject]) s.subjects[subject] = { createdAt: Date.now(), videos: [] }
      if (!s.subjects[subject].videos.includes(title)) s.subjects[subject].videos.push(title)
    })
  }

  const subjectExists = (subject) => Boolean(readState().subjects[subject])

  function buildIndexMarkdown() {
    const s = readState()
    const subjects = Object.keys(s.subjects)
    const lines = ['# 视频课程知识地图', '', `> 自动生成 · 最后更新 ${new Date().toLocaleString('zh-CN', { hour12: false })}`, '', '## 学科总览', '```mermaid', 'mindmap', '  root((课程知识地图))']
    for (const sub of subjects) lines.push(`    ${sub}`)
    lines.push('```', '', '## 学科列表')
    if (subjects.length === 0) lines.push('（暂无，开始观看视频课程后会自动生成）')
    for (const sub of subjects) {
      const n = s.subjects[sub]?.videos?.length ?? 0
      lines.push(`- ${sub} — ${n} 个视频 → 「${sub}/学习手册.docx」`)
    }
    lines.push('')
    return lines.join('\n')
  }

  function saveIndexMd() { atomicWrite(indexMdPath(), buildIndexMarkdown()) }

  // ---- 进程锁：同一时刻只允许一个实例轮询写入 ----
  function readLock() {
    try { return JSON.parse(readFileSync(lockPath, 'utf8')) } catch { return null }
  }

  function lockFresh(lock) {
    if (!lock) return false
    if (lock.owner === owner && lock.pid === process.pid) return true
    const fresh = Date.now() - Number(lock.heartbeatAt || 0) < LOCK_TTL_MS
    return fresh && pidAlive(Number(lock.pid))
  }

  function acquireLock() {
    const cur = readLock()
    if (cur && lockFresh(cur) && !(cur.owner === owner && cur.pid === process.pid)) return false
    atomicWrite(lockPath, JSON.stringify({ owner, pid: process.pid, startedAt: Date.now(), heartbeatAt: Date.now() }))
    return true
  }

  function touchLock() {
    const cur = readLock()
    if (!cur || cur.owner !== owner || cur.pid !== process.pid) return
    atomicWrite(lockPath, JSON.stringify({ ...cur, heartbeatAt: Date.now() }))
  }

  function releaseLock() {
    const cur = readLock()
    if (cur && cur.owner === owner && cur.pid === process.pid) {
      try { writeFileSync(lockPath, '', 'utf8') } catch { /* 忽略 */ }
    }
  }

  function canRun() {
    const cur = readLock()
    if (!cur) return true
    if (cur.owner === owner && cur.pid === process.pid) return true // 自己持有锁
    return !lockFresh(cur)
  }

  const lockInfo = () => readLock()

  function docxMtime(path) {
    try { return statSync(path).mtimeMs } catch { return 0 }
  }

  return {
    outputDir, stateDir, owner,
    readState, writeState, mutate, log, readLog,
    isSeen, markSeen, markRun, resetSeen, subjectsList, subjectExists, addSubjectVideo,
    manualMdPath, manualDocxPath, indexMdPath, indexDocxPath,
    createSubjectManual, appendVideo, regenerateOverview, saveIndexMd, buildIndexMarkdown,
    acquireLock, touchLock, releaseLock, canRun, lockInfo,
    docxMtime,
  }
}

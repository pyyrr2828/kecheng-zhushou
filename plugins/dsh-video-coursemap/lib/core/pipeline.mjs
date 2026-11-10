/** 轮询 → 判定 → 分类 → 抓取 → 生成 → 落盘 的完整流水线（插件与独立应用共用）。 */
import { readForeground } from './poll.mjs'
import { cleanTitle, isBrowserProc, isPlatformHome, sanitizeSubject } from './title.mjs'
import { classify, generate } from './note.mjs'
import { fetchBiliContent } from './bili.mjs'
import { convertToDocx, findPython } from './docx.mjs'

/**
 * @param {object} opts
 * @param {object} opts.store   createStore() 的返回值
 * @param {{complete:Function}} opts.llm  提供 complete({system,messages,maxTokens,onToken})
 * @param {object} opts.config {stablePolls,titleMinLen,fetchContent,maxTokens,llmConfigured}
 * @param {(e:object)=>void} opts.emit 事件回调（app 用它推 SSE，插件写日志）
 */
export function createAgent({ store, llm, config, emit = () => {} }) {
  const pythonPath = findPython()
  let running = false
  let pending = null
  let queued = null

  const now = () => Date.now()
  const fire = (e) => { try { emit({ at: now(), ...e }) } catch { /* 忽略 */ } }

  async function convertSafe(mdPath, docxPath, tag) {
    try {
      convertToDocx(pythonPath, mdPath, docxPath)
      return true
    } catch (e) {
      fire({ type: 'error', code: 'DOCX_FAILED', message: `${tag}：${e.message}` })
      return false
    }
  }

  async function processTitle(title) {
    if (running) { fire({ type: 'decision', verdict: 'busy', cleaned: title }); queued = title; return }
    running = true
    try {
      if (config.llmConfigured === false) {
        fire({ type: 'error', code: 'NO_LLM', message: '未配置模型，跳过总结' })
        store.markSeen(title)
        return
      }
      const existing = store.subjectsList().map((s) => s.subject)
      const cls = await classify({ title, existingSubjects: existing, llm, maxTokens: 700 })
      if (!cls) {
        store.markSeen(title)
        fire({ type: 'error', code: 'CLASSIFY_FAILED', message: '分类结果无法解析' })
        return
      }
      fire({ type: 'classify', title, isCourse: cls.isCourse !== false, subject: cls.subject ?? '', keywords: Array.isArray(cls.keywords) ? cls.keywords : [] })
      if (cls.isCourse === false) {
        store.markSeen(title)
        fire({ type: 'decision', verdict: 'not-course', cleaned: title })
        return
      }
      const subject = sanitizeSubject(cls.subject)
      const clean = String(cls.title || title).trim() || title
      const keywords = (Array.isArray(cls.keywords) ? cls.keywords : []).map(String).filter(Boolean)

      let content = null
      if (config.fetchContent !== false) {
        try {
          content = await fetchBiliContent(clean)
          if (content?.tags?.length) {
            for (const t of content.tags) if (t && !keywords.includes(t) && keywords.length < 10) keywords.push(t)
          }
          fire({
            type: 'fetch',
            bvid: content?.bvid ?? null,
            matchScore: content?.matchScore ?? null,
            danmaku: content?.danmaku?.length ?? 0,
            comments: content?.comments?.length ?? 0,
            transcript: content?.transcript ? 1 : 0,
          })
        } catch (e) {
          fire({ type: 'error', code: 'BILI_FAILED', message: e.message })
        }
      }

      fire({ type: 'generate-start', title: clean, subject })
      const md = await generate({
        title: clean, subject, keywords, content, llm, maxTokens: config.maxTokens ?? 4096,
        onToken: (text) => fire({ type: 'token', text }),
      })
      if (!String(md || '').trim()) throw new Error('模型返回空内容')

      const isNew = !store.subjectExists(subject)
      if (isNew) store.createSubjectManual(subject)
      store.appendVideo(subject, md)
      store.addSubjectVideo(subject, clean)
      store.regenerateOverview(subject)
      const docxOk = await convertSafe(store.manualMdPath(subject), store.manualDocxPath(subject), '学习手册')
      store.saveIndexMd()
      await convertSafe(store.indexMdPath(), store.indexDocxPath(), '课程总览')
      store.markRun(title)
      fire({
        type: 'generate-done',
        subject, title: clean, isNewSubject: isNew, docxOk,
        docx: docxOk ? store.manualDocxPath(subject) : null,
      })
    } catch (e) {
      fire({ type: 'error', code: e.code || 'PROCESS_FAILED', message: e.message })
    } finally {
      running = false
      const next = queued
      queued = null
      if (next) setTimeout(() => { processTitle(next).catch(() => {}) }, 0)
    }
  }

  async function observe() {
    if (store.canRun() === false) {
      fire({ type: 'skipped', reason: 'locked', lock: store.lockInfo() })
      return
    }
    const fg = await readForeground()
    if (!fg) { fire({ type: 'error', code: 'FG_READ_FAILED', message: '读不到前台窗口' }); return }
    fire({ type: 'tick', proc: fg.proc, title: fg.title })
    if (!isBrowserProc(fg.proc)) { fire({ type: 'decision', verdict: 'ignored-proc', proc: fg.proc, cleaned: cleanTitle(fg.title) }); return }
    const title = cleanTitle(fg.title)
    if (title.length < (config.titleMinLen ?? 4)) { fire({ type: 'decision', verdict: 'too-short', cleaned: title }); return }
    if (isPlatformHome(title)) { fire({ type: 'decision', verdict: 'platform-home', cleaned: title }); return }
    if (store.isSeen(title)) { pending = null; fire({ type: 'decision', verdict: 'seen', cleaned: title }); return }
    if (!pending || pending.title !== title) pending = { title, count: 1 }
    else pending.count += 1
    fire({ type: 'decision', verdict: 'pending', cleaned: title, stable: pending.count, need: config.stablePolls ?? 2 })
    if (pending.count >= (config.stablePolls ?? 2)) {
      const t = pending.title
      pending = null
      await processTitle(t)
    }
  }

  function resetPending() { pending = null }

  return { observe, processTitle, resetPending, get busy() { return running } }
}

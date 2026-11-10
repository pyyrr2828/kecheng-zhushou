/** 笔记的删除 / 重建操作：只依赖 core 的 store 与 docx 转换。 */
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { convertToDocx, findPython } from '../plugins/dsh-video-coursemap/lib/core/docx.mjs'

const SEP = '\n\n---\n\n'

export function createNotesOps({ store }) {
  const pythonPath = findPython()

  function rebuildSubject(subject) {
    const md = store.manualMdPath(subject)
    if (!existsSync(md)) return false
    convertToDocx(pythonPath, md, store.manualDocxPath(subject))
    return true
  }

  function rebuildIndex() {
    store.saveIndexMd()
    if (store.subjectsList().length === 0) {
      const docx = store.indexDocxPath()
      if (existsSync(docx)) rmSync(docx, { force: true })
      return false
    }
    convertToDocx(pythonPath, store.indexMdPath(), store.indexDocxPath())
    return true
  }

  function rebuildAll() {
    const subjects = store.subjectsList()
    const failed = []
    for (const s of subjects) {
      try { rebuildSubject(s.subject) } catch (e) { failed.push({ subject: s.subject, error: e.message }) }
    }
    try { rebuildIndex() } catch (e) { failed.push({ subject: '(总览)', error: e.message }) }
    return { rebuilt: subjects.length, failed }
  }

  /** 视频章节列表（按 md 里的顺序）。 */
  function listVideos(subject) {
    const md = store.manualMdPath(subject)
    const fromState = (store.readState().subjects[subject]?.videos ?? []).slice()
    if (!existsSync(md)) return fromState.map((t) => ({ title: t, inMarkdown: false }))
    const text = readFileSync(md, 'utf8')
    const sections = text.split(SEP).slice(1) // 第一段是「学习手册 + 学科总览」头部
    const fromMd = sections.map((sec) => {
      const m = sec.match(/^##\s+(.+)$/m)
      return m ? m[1].trim() : ''
    }).filter(Boolean)
    const titles = [...new Set([...fromMd, ...fromState])]
    return titles.map((t) => ({ title: t, inMarkdown: fromMd.includes(t) }))
  }

  /** 删除某个视频章节（md 段落 + state.videos + 去重表），并重建 Word。 */
  function deleteVideo(subject, title, { keepSeen = false } = {}) {
    if (!store.subjectExists(subject)) throw new Error('没有这个学科：' + subject)
    const md = store.manualMdPath(subject)
    if (!existsSync(md)) throw new Error('该学科没有 Markdown 源')
    const text = readFileSync(md, 'utf8')
    const parts = text.split(SEP)
    const head = parts[0]
    const keep = []
    let removed = 0
    for (const sec of parts.slice(1)) {
      const m = sec.match(/^##\s+(.+)$/m)
      const secTitle = m ? m[1].trim() : ''
      if (secTitle === title) { removed += 1; continue }
      keep.push(sec)
    }
    if (removed === 0) throw new Error('md 里找不到这一章：' + title)
    writeFileSync(md, [head, ...keep].join(SEP), 'utf8')
    store.mutate((s) => {
      const d = s.subjects[subject]
      if (d && Array.isArray(d.videos)) d.videos = d.videos.filter((v) => v !== title)
      if (!keepSeen) delete s.seen[title]
    })
    rebuildSubject(subject)
    try { rebuildIndex() } catch { /* 总览重建失败不影响章节删除 */ }
    return { removed }
  }

  /** 删除整个学科（目录 + docx + md + state 记录 + 去重条目），并重建总览。 */
  function deleteSubject(subject, { keepSeen = false } = {}) {
    if (!store.subjectExists(subject)) throw new Error('没有这个学科：' + subject)
    const videos = (store.readState().subjects[subject]?.videos ?? []).slice()
    const errors = []
    for (const target of [store.manualDocxPath(subject), join(store.outputDir, subject)]) {
      try { if (existsSync(target)) rmSync(target, { recursive: true, force: true }) } catch (e) { errors.push(e.message) }
    }
    const md = store.manualMdPath(subject)
    try { if (existsSync(md)) rmSync(md, { force: true }) } catch (e) { errors.push(e.message) }
    store.mutate((s) => {
      delete s.subjects[subject]
      if (!keepSeen) for (const v of videos) delete s.seen[v]
    })
    try { rebuildIndex() } catch (e) { errors.push('重建总览失败：' + e.message) }
    if (errors.length) throw new Error('部分文件未能删除：' + errors.join('；'))
    return { videos: videos.length }
  }

  return { listVideos, deleteVideo, deleteSubject, rebuildSubject, rebuildIndex, rebuildAll }
}

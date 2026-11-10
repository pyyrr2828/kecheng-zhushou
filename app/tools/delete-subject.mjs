/**
 * 删除某个学科的笔记（学习手册 md + docx + state 记录 + 去重表条目），并重建《课程总览.docx》。
 *
 *   node app/tools/delete-subject.mjs --list
 *   node app/tools/delete-subject.mjs "Python爬虫" --yes
 *   node app/tools/delete-subject.mjs "Python爬虫" --yes --keep-seen   # 保留去重记录（以后看到同一视频仍静默）
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createStore } from '../../plugins/dsh-video-coursemap/lib/core/store.mjs'
import { convertToDocx, findPython } from '../../plugins/dsh-video-coursemap/lib/core/docx.mjs'

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const config = (() => {
  try { return JSON.parse(readFileSync(join(APP_DIR, 'config.json'), 'utf8')) } catch { return {} }
})()

const store = createStore({ outputDir: config.outputDir || join(homedir(), '课程知识地图'), owner: 'cli' })
const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const subject = args.find((a) => !a.startsWith('--'))

if (flags.has('--list')) {
  const list = store.subjectsList()
  if (!list.length) console.log('（还没有任何学科）')
  for (const s of list) {
    const docx = store.manualDocxPath(s.subject)
    console.log(`- ${s.subject}（${s.videos} 个视频，docx ${existsSync(docx) ? '有' : '无'}）`)
  }
  process.exit(0)
}

if (!subject) {
  console.error('用法：node app/tools/delete-subject.mjs <学科名> --yes   （先 --list 看有哪些）')
  process.exit(1)
}
if (!flags.has('--yes')) {
  console.error(`将删除「${subject}」的 md、docx 与 state 记录。确认请加 --yes`)
  process.exit(1)
}
if (!store.subjectExists(subject)) {
  console.error(`没有这个学科：${subject}（用 --list 查看）`)
  process.exit(1)
}

const dir = join(store.outputDir, subject)
const md = store.manualMdPath(subject)
const docx = store.manualDocxPath(subject)
const videos = (store.readState().subjects[subject]?.videos ?? []).slice()
const errors = []

for (const [label, target] of [['docx', docx], ['目录', dir]]) {
  try { if (existsSync(target)) rmSync(target, { recursive: true, force: true }) } catch (e) { errors.push(`${label} 删除失败（可能被 Word 占用）：${target} — ${e.message}`) }
}
try { if (existsSync(md)) rmSync(md, { force: true }) } catch (e) { errors.push('md 删除失败：' + e.message) }

store.mutate((s) => {
  delete s.subjects[subject]
  if (!flags.has('--keep-seen')) {
    for (const v of videos) delete s.seen[v]
  }
})

// 重建课程总览
try {
  store.saveIndexMd()
  if (store.subjectsList().length > 0) {
    convertToDocx(findPython(), store.indexMdPath(), store.indexDocxPath())
  } else if (existsSync(store.indexDocxPath())) {
    rmSync(store.indexDocxPath(), { force: true })
  }
} catch (e) {
  errors.push('重建课程总览失败：' + e.message)
}

console.log(`已删除学科「${subject}」：${videos.length} 个视频记录${flags.has('--keep-seen') ? '（保留去重）' : '（去重条目一并清除）'}`)
if (errors.length) { console.error('注意：'); for (const e of errors) console.error(' - ' + e) }
process.exit(errors.length ? 1 : 0)

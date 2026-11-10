/**
 * dsh-course-notes — 课程笔记投递插件
 *
 * 与 dsh-video-coursemap 配合：coursemap 负责「检测前台视频 → 分类学科 → 抓 B 站
 * 内容/弹幕/评论 → 生成 Word 知识地图」，本插件负责「收件箱 + 投递到会话对话框」。
 *
 * 提供两个工具：
 *  - course_notes_inbox   列出已生成的知识地图文档（学科 / 文件 / 大小 / 是否已投递）
 *  - course_notes_deliver 取出待投递的文档（供 agent 用 present 在对话框里呈现），并标记已投递
 *
 * 纯插件、零运行时依赖。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, basename, relative } from 'node:path'

export const name = 'dsh-course-notes'
export const inject = ['tools']

const DEFAULTS = {
  outputDir: null, // null → 与 coursemap 默认一致：<用户目录>/课程知识地图
  presentLimit: 4, // 单次投递最多返回几个文件（present 上限 4）
}

function resolveConfig(raw) {
  if (raw === null || raw === undefined) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('dsh-course-notes: 配置必须是对象')
  const config = { ...DEFAULTS }
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (!(key in DEFAULTS)) throw new Error(`dsh-course-notes: 未知配置项 "${key}"`)
    config[key] = value
  }
  config.outputDir = config.outputDir ?? join(homedir(), '课程知识地图')
  if (typeof config.presentLimit !== 'number' || config.presentLimit <= 0) throw new Error('dsh-course-notes: presentLimit 必须是正数')
  return config
}

function ensureDir(p) { if (!existsSync(p)) mkdirSync(p, { recursive: true }) }

function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback }
}

function writeJsonAtomic(p, data) {
  ensureDir(dirname(p))
  const tmp = `${p}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  renameSync(tmp, p)
}

/** 递归收集 .docx（跳过 .state 与临时文件）。 */
function listDocx(dir) {
  const out = []
  const walk = (d) => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === '.state' || e.name.startsWith('.')) continue
      const full = join(d, e.name)
      if (e.isDirectory()) { walk(full); continue }
      if (!e.isFile() || !/\.docx$/i.test(e.name)) continue
      if (e.name.startsWith('~$')) continue
      try {
        const st = statSync(full)
        out.push({ path: full, sizeKB: Math.round(st.size / 1024), updatedAt: st.mtimeMs })
      } catch { /* 忽略 */ }
    }
  }
  walk(dir)
  return out
}

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const stateDir = join(config.outputDir, '.state')
  const deliveredPath = join(stateDir, 'delivered.json')
  const coursemapStatePath = join(stateDir, 'state.json')

  function loadDelivered() {
    const j = readJson(deliveredPath, {})
    return j && typeof j === 'object' ? j : {}
  }

  function subjectsOf() {
    const s = readJson(coursemapStatePath, {})
    const subjects = s?.subjects && typeof s.subjects === 'object' ? s.subjects : {}
    return Object.entries(subjects).map(([subject, d]) => ({ subject, videos: d?.videos?.length ?? 0 }))
  }

  function collect() {
    const delivered = loadDelivered()
    const subjects = subjectsOf()
    return listDocx(config.outputDir).map((f) => {
      const rel = relative(config.outputDir, f.path)
      const subject = rel.includes('\\') ? rel.split('\\')[0] : (basename(f.path, '.docx') === '课程总览' ? '课程总览' : '未分类')
      return {
        path: f.path,
        subject,
        file: basename(f.path),
        sizeKB: f.sizeKB,
        updatedAt: Math.round(f.updatedAt),
        delivered: Object.hasOwn(delivered, f.path),
        videos: subjects.find((s) => s.subject === subject)?.videos ?? 0,
      }
    }).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  ctx.effect(() => ctx.tools.register({
    name: 'course_notes_inbox',
    description: '列出「视频课程知识地图」已生成的知识地图 Word 文档（按学科目录组织），标注大小、更新时间以及是否已经投递到会话。用于查看课程笔记产出、决定投递哪些文档。',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '可选：只看某个学科的文档（如 Python爬虫）' },
        pendingOnly: { type: 'boolean', description: '可选：只列出尚未投递过的文档' },
        limit: { type: 'number', description: '可选：最多返回几条，默认 20' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          outputDir: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                subject: { type: 'string' }, file: { type: 'string' }, path: { type: 'string' },
                sizeKB: { type: 'integer' }, updatedAt: { type: 'integer' },
                delivered: { type: 'boolean' }, videos: { type: 'integer' },
              },
              required: ['subject', 'file', 'path'],
            },
          },
          message: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message ?? '' }],
    },
    async execute(args = {}) {
      let items = collect()
      if (typeof args.subject === 'string' && args.subject.trim()) {
        const key = args.subject.trim()
        items = items.filter((i) => i.subject === key)
      }
      if (args.pendingOnly === true) items = items.filter((i) => !i.delivered)
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 20
      items = items.slice(0, limit)
      const lines = [
        `课程笔记收件箱（${config.outputDir}）：`,
        ...(items.length === 0
          ? ['（暂无文档，先看一个 B 站课程视频或调用 course_map_scan）']
          : items.map((i) => `- ${i.subject} / ${i.file}（${i.sizeKB}KB，${i.delivered ? '已投递' : '待投递'}）→ ${i.path}`)),
      ]
      return { ok: true, outputDir: config.outputDir, items, message: lines.join('\n') }
    },
  }), 'dsh-course-notes: inbox tool')

  ctx.effect(() => ctx.tools.register({
    name: 'course_notes_deliver',
    description: '取出待投递的知识地图 Word 文档，供在当前会话对话框里呈现（配合 present 工具），并把它们标记为已投递。不传参数时投递最近更新的若干份。',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '可选：只投递某个学科的文档' },
        path: { type: 'string', description: '可选：直接指定要投递的 docx 绝对路径' },
        includeDelivered: { type: 'boolean', description: '可选：true 时连已投递过的也再投一次（默认只投待投递的）' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          files: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                subject: { type: 'string' }, path: { type: 'string' },
                caption: { type: 'string' }, sizeKB: { type: 'integer' },
              },
              required: ['path'],
            },
          },
          message: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message ?? '' }],
    },
    async execute(args = {}) {
      let items = collect()
      if (typeof args.path === 'string' && args.path.trim()) {
        const want = args.path.trim()
        items = items.filter((i) => i.path.toLowerCase() === want.toLowerCase())
        if (items.length === 0 && existsSync(want)) {
          const p = want
          items = [{ path: p, subject: '未分类', file: basename(p), sizeKB: Math.round(statSync(p).size / 1024), updatedAt: Date.now(), delivered: false, videos: 0 }]
        }
      } else if (typeof args.subject === 'string' && args.subject.trim()) {
        const key = args.subject.trim()
        items = items.filter((i) => i.subject === key)
      }
      if (args.includeDelivered !== true) {
        const pending = items.filter((i) => !i.delivered)
        if (pending.length > 0) items = pending
      }
      items = items.slice(0, config.presentLimit)
      if (items.length === 0) {
        return { ok: false, files: [], message: '没有可投递的文档：收件箱为空，或该学科下还没有生成 docx。' }
      }
      const delivered = loadDelivered()
      for (const it of items) delivered[it.path] = Date.now()
      writeJsonAtomic(deliveredPath, delivered)
      const files = items.map((i) => ({
        subject: i.subject, path: i.path, sizeKB: i.sizeKB,
        caption: i.subject === '课程总览' ? '课程知识地图 · 学科总览' : `${i.subject} · 学习手册（${i.videos || 1} 个视频）`,
      }))
      return {
        ok: true,
        files,
        message: '待投递文档：\n' + files.map((f) => `- ${f.caption} → ${f.path}`).join('\n')
          + '\n\n请在会话里用 present 工具把这些文件呈现给用户（文件卡片会出现在对话框里）。',
      }
    },
  }), 'dsh-course-notes: deliver tool')

  console.log(`[dsh-course-notes] 已启动：知识地图收件箱 ${config.outputDir}`)
}

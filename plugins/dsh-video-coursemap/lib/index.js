/**
 * dsh-video-coursemap — DSH 插件适配层
 *
 * 检测/抓取/生成/落盘的全部逻辑在 ./core/*，与独立应用 app/ 共用；
 * 这里只负责：读配置、接 ctx.llm、注册 course_map_status / course_map_scan、起定时器。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createStore } from './core/store.mjs'
import { createAgent } from './core/pipeline.mjs'
import { initPollScript } from './core/poll.mjs'
import { cleanTitle } from './core/title.mjs'

export const name = 'dsh-video-coursemap'
export const inject = ['llm', 'tools']

export const DEFAULTS = {
  enabled: true,
  pollIntervalMs: 15000,
  stablePolls: 2,
  outputDir: null,
  provider: null,
  model: null,
  maxTokens: 4096,
  titleMinLen: 4,
  fetchContent: true,
}

function resolveConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-video-coursemap: 配置必须是对象')
  }
  const config = { ...DEFAULTS }
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (!(key in DEFAULTS)) throw new Error(`dsh-video-coursemap: 未知配置项 "${key}"`)
    config[key] = value
  }
  for (const key of ['pollIntervalMs', 'stablePolls', 'maxTokens', 'titleMinLen']) {
    const v = config[key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`dsh-video-coursemap: ${key} 必须是正数`)
    }
  }
  if (typeof config.enabled !== 'boolean') throw new Error('dsh-video-coursemap: enabled 必须是布尔值')
  if (typeof config.fetchContent !== 'boolean') throw new Error('dsh-video-coursemap: fetchContent 必须是布尔值')
  for (const key of ['provider', 'model']) {
    if (config[key] !== null && (typeof config[key] !== 'string' || config[key].trim() === '')) {
      throw new Error(`dsh-video-coursemap: ${key} 必须是 null 或非空字符串`)
    }
  }
  config.outputDir = config.outputDir ?? join(homedir(), '课程知识地图')
  return config
}

function resolveModel(ctx, config) {
  if (config.provider && config.model) return { provider: config.provider, model: config.model }
  try {
    const sel = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (sel && typeof sel.provider === 'string' && typeof sel.model === 'string') {
      return { provider: sel.provider, model: sel.model }
    }
  } catch { /* 忽略 */ }
  try {
    const providers = ctx.llm?.listProviders?.() ?? []
    for (const p of providers) {
      const mid = p.models?.[0]?.id ?? p.defaultModel ?? p.model
      if (p.id && mid) return { provider: p.id, model: mid }
    }
  } catch { /* 忽略 */ }
  return { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
}

function makeLlm(ctx, config) {
  return {
    async complete({ system, messages, maxTokens }) {
      const model = resolveModel(ctx, config)
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error('dsh-video-coursemap: LLM 调用超时')), 120000)
      try {
        const stream = ctx.llm.stream({
          provider: model.provider,
          model: model.model,
          system,
          messages: messages.map((m) => ({ ...m, id: randomUUID() })),
          maxTokens: maxTokens ?? config.maxTokens,
          signal: ac.signal,
        })
        let text = ''
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        }
        return text
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  if (!existsSync(config.outputDir)) mkdirSync(config.outputDir, { recursive: true })
  const store = createStore({ outputDir: config.outputDir, owner: 'dsh-plugin' })
  initPollScript(store.stateDir)

  const llm = makeLlm(ctx, config)

  function logLine(msg) { store.log(msg) }

  const agent = createAgent({
    store,
    llm,
    config: { ...config, llmConfigured: true },
    emit(e) {
      switch (e.type) {
        case 'tick': logLine(`fg proc=${e.proc} title=${JSON.stringify(e.title)}`); break
        case 'decision': logLine(`verdict=${e.verdict} cleaned=${JSON.stringify(e.cleaned ?? '')}`); break
        case 'classify': logLine(`classify title=${JSON.stringify(e.title)} subject=${e.subject} isCourse=${e.isCourse}`); break
        case 'fetch': logLine(`bili bvid=${e.bvid ?? 'none'} danmaku=${e.danmaku} comments=${e.comments}`); break
        case 'generate-done': logLine(`done subject=${e.subject} title=${JSON.stringify(e.title)}`); break
        case 'error': logLine(`error code=${e.code} msg=${e.message}`); break
        case 'skipped': logLine(`skipped reason=${e.reason}`); break
        default: break
      }
    },
  })

  // 启动时为已有学科重刷 Word（失败只记日志）
  try {
    for (const s of store.subjectsList()) {
      if (!existsSync(store.manualMdPath(s.subject))) continue
      store.regenerateOverview(s.subject)
    }
    if (store.subjectsList().length > 0) store.saveIndexMd()
  } catch (error) {
    logLine(`startup error msg=${error?.message ?? error}`)
  }

  ctx.effect(() => ctx.tools.register({
    name: 'course_map_status',
    description: '查看「视频课程知识地图 Agent」的运行状态：是否启用、输出目录、已分类学科与视频数、最近观察到的标题。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean' }, enabled: { type: 'boolean' },
          outputDir: { type: 'string' }, lastTitle: { type: 'string' },
          lastRunAt: { type: 'integer' },
          subjects: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { subject: { type: 'string' }, videos: { type: 'integer' } }, required: ['subject', 'videos'] } },
          message: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message ?? '' }],
    },
    async execute() {
      const subjects = store.subjectsList().map((s) => ({ subject: s.subject, videos: s.videos }))
      const st = store.readState()
      const message = [
        '视频课程知识地图 Agent 状态：',
        `- 启用：${config.enabled}`,
        `- 输出目录：${config.outputDir}`,
        `- 学科数：${subjects.length}`,
        ...subjects.map((s) => `  · ${s.subject}（${s.videos} 个视频）`),
        `- 最近观察：${st.lastTitle || '（无）'}`,
      ].join('\n')
      return { ok: true, enabled: config.enabled, outputDir: config.outputDir, lastTitle: st.lastTitle, lastRunAt: st.lastRunAt, subjects, message }
    },
  }), 'dsh-video-coursemap: status tool')

  ctx.effect(() => ctx.tools.register({
    name: 'course_map_scan',
    description: '立即执行一次前台窗口观察与知识地图生成（绕过轮询间隔，便于测试或手动触发）；可传 title 直接指定要处理的视频标题。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '可选：直接指定要处理的视频标题（跳过前台窗口读取，便于测试/手动输入）' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        required: ['ok'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message ?? '' }],
    },
    async execute(args) {
      if (!config.enabled) return { ok: false, message: 'Agent 未启用（config.enabled=false）' }
      if (store.canRun() === false) {
        const lock = store.lockInfo()
        return { ok: false, message: `独立应用「课程助手」正在运行（pid ${lock?.pid}），已跳过；请先退出应用。` }
      }
      let title = null
      if (args && typeof args.title === 'string' && args.title.trim()) {
        title = cleanTitle(args.title)
      } else {
        const { readForeground } = await import('./core/poll.mjs')
        const fg = await readForeground()
        if (!fg) return { ok: false, message: '无法读取前台窗口' }
        title = cleanTitle(fg.title)
        const { isBrowserProc } = await import('./core/title.mjs')
        if (!isBrowserProc(fg.proc)) return { ok: false, message: `前台窗口不是浏览器/视频客户端（进程 ${fg.proc || '未知'}）：${fg.title}` }
      }
      await agent.processTitle(title)
      return { ok: true, message: `已处理「${title}」，已生成 Word 文档。输出目录：${config.outputDir}` }
    },
  }), 'dsh-video-coursemap: scan tool')

  ctx.effect(() => {
    const id = setInterval(() => {
      if (!config.enabled) return
      agent.observe().catch((e) => logLine(`observe error ${e?.message ?? e}`))
    }, config.pollIntervalMs)
    return () => clearInterval(id)
  }, 'dsh-video-coursemap: poll timer')

  console.log(`[dsh-video-coursemap] 已启动：每 ${config.pollIntervalMs}ms 轮询前台窗口，输出目录 ${config.outputDir}`)
}

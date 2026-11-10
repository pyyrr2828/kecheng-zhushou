/**
 * 核心逻辑自测（离线、不碰真实笔记）：node tests/run.mjs
 * 覆盖：标题清洗 / JSON 容错 / 流水线（假模型）/ 笔记删除 / 去重表
 */
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cleanTitle, isPlatformHome, isBrowserProc, sanitizeSubject } from '../plugins/dsh-video-coursemap/lib/core/title.mjs'
import { parseJson } from '../plugins/dsh-video-coursemap/lib/core/note.mjs'
import { createStore } from '../plugins/dsh-video-coursemap/lib/core/store.mjs'
import { createAgent } from '../plugins/dsh-video-coursemap/lib/core/pipeline.mjs'
import { createNotesOps } from '../app/notes-ops.mjs'

let pass = 0
const fails = []

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fails.push(name + (extra ? ' — ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')) }
}

console.log('\n[1] cleanTitle')
{
  const cases = [
    ['Python爬虫 零基础入门到精通 上_哔哩哔哩_bilibili - 个人 - Microsoft\u200b Edge', 'Python爬虫 零基础入门到精通 上'],
    ['线性代数 - 宋浩_哔哩哔哩_bilibili - 用户配置 1 - Microsoft Edge', '线性代数 - 宋浩'],
    ['【全748集】Python全套教程_哔哩哔哩_bilibili', '【全748集】Python全套教程'],
    ['高等数学 6小时速成课 - YouTube - Google Chrome', '高等数学 6小时速成课'],
    ['《微积分》上册 2.0版｜宋浩老师', '《微积分》上册 2.0版｜宋浩老师'],
  ]
  for (const [raw, want] of cases) ok('clean ' + want.slice(0, 12), cleanTitle(raw) === want, cleanTitle(raw))
  ok('首页仍被识别', isPlatformHome(cleanTitle('哔哩哔哩 (゜-゜)つロ 干杯~-bilibili')))
  ok('非浏览器进程', !isBrowserProc('explorer') && isBrowserProc('msedge'))
  ok('学科名净化', sanitizeSubject('a/b:c*d') === 'a_b_c_d', sanitizeSubject('a/b:c*d'))
}

console.log('\n[2] parseJson 容错')
{
  ok('裸 JSON', parseJson('{"a":1}')?.a === 1)
  ok('代码块包裹', parseJson('\u0060\u0060\u0060json\n{"a":2}\n\u0060\u0060\u0060')?.a === 2)
  ok('尾逗号修复', parseJson('{"a":3,}')?.a === 3)
  ok('前后噪音', parseJson('好的：{"a":4} 以上')?.a === 4)
  ok('无法解析返回 null', parseJson('完全不是 JSON') === null)
}

console.log('\n[3] 流水线（假模型，不出网）')
const dir = mkdtempSync(join(tmpdir(), 'course-notes-'))
const store = createStore({ outputDir: dir, owner: 'test' })
const llm = {
  async complete({ messages, onToken }) {
    const text = messages[0].content[0].text
    if (text.includes('浏览器当前标题')) {
      const cls = JSON.stringify({ isCourse: true, subject: '测试学科', title: '测试视频', keywords: ['甲', '乙'] })
      if (onToken) onToken(cls)
      return cls
    }
    const fence = String.fromCharCode(96).repeat(3)
    const md = ['## 测试视频', '', '> 简介', '', '### 核心知识点', '- **甲**', '  - 要点', '', '### 思维导图', fence + 'mermaid', 'mindmap', '  root((测试))', fence, ''].join('\n')
    if (onToken) onToken(md)
    return md
  },
}
const events = []
const agent = createAgent({
  store, llm,
  config: { stablePolls: 2, titleMinLen: 4, fetchContent: false, maxTokens: 512, llmConfigured: true },
  emit: (e) => events.push(e.type),
})
await agent.processTitle('测试视频')
ok('事件顺序', events.join(',') === 'classify,generate-start,token,generate-done', events.join(','))
ok('state 有学科', store.subjectsList().length === 1 && store.subjectsList()[0].subject === '测试学科')
ok('markdown 落盘', existsSync(store.manualMdPath('测试学科')))
ok('docx 落盘', existsSync(store.manualDocxPath('测试学科')) && statSync(store.manualDocxPath('测试学科')).size > 1000)
ok('去重表已记', store.isSeen('测试视频'))
ok('总览生成', existsSync(store.indexDocxPath()))

console.log('\n[4] 删除与重建')
{
  const ops = createNotesOps({ store })
  store.appendVideo('测试学科', '## 第二个视频\n\n> 简介二')
  store.addSubjectVideo('测试学科', '第二个视频')
  store.markSeen('第二个视频')
  ok('章节列表', ops.listVideos('测试学科').length === 2)

  ops.deleteVideo('测试学科', '第二个视频')
  const md = readFileSync(store.manualMdPath('测试学科'), 'utf8')
  ok('章节已删', !md.includes('第二个视频') && md.includes('测试视频'))
  ok('去重条目已清', !store.isSeen('第二个视频'))
  ok('docx 重建', existsSync(store.manualDocxPath('测试学科')))

  ops.deleteSubject('测试学科')
  ok('学科已删', !store.subjectExists('测试学科') && !existsSync(join(dir, '测试学科')))
  ok('总览清理', !existsSync(store.indexDocxPath()))
}

console.log('\n[5] 进程锁')
{
  const a = createStore({ outputDir: dir, owner: 'app' })
  const b = createStore({ outputDir: dir, owner: 'dsh-plugin' })
  ok('首个实例拿锁', a.acquireLock() === true)
  ok('自己始终可运行', a.canRun() === true)
  ok('另一实例被挡', b.canRun() === false)
  a.releaseLock()
  ok('释放后放行', b.canRun() === true)
}

rmSync(dir, { recursive: true, force: true })

console.log('\n' + (fails.length ? '失败 ' + fails.length + ' 项：\n - ' + fails.join('\n - ') : '全部通过（' + pass + ' 项）'))
process.exit(fails.length ? 1 : 0)

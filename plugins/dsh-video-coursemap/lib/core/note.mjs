/** 分类与总结：只依赖注入的 llm.complete({system,messages,maxTokens,onToken})。 */
import { mermaidSafe } from './title.mjs'

export function parseJson(text) {
  if (!text) return null
  const t = String(text).trim()
  try { return JSON.parse(t) } catch { /* 继续 */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) {
    try { return JSON.parse(fence[1].trim()) } catch { /* 继续 */ }
  }
  const m = t.match(/\{[\s\S]*\}/)
  if (!m) return null
  const candidate = m[0]
  try { return JSON.parse(candidate) } catch { /* 继续 */ }
  try {
    const fixed = candidate
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
      .replace(/:\s*'([^']*)'/g, ':"$1"')
    return JSON.parse(fixed)
  } catch { return null }
}

const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }] })

/** 判断是否值得整理成知识地图，并归类学科。 */
export async function classify({ title, existingSubjects, llm, maxTokens = 700 }) {
  const system = '你是视频内容分类助手。判断一个「浏览器当前标题」是否值得整理成知识地图，并归类到学科。'
  const user = `浏览器当前标题：${JSON.stringify(title)}
已有学科列表：${JSON.stringify(existingSubjects)}

只返回一个合法 JSON 对象（不要任何多余文字、不要 markdown 代码块、不要尾逗号），格式：
{"isCourse":true,"subject":"学科名","title":"清洗后的视频标题","keywords":["关键词1","关键词2"]}

规则：
- isCourse 填 true 的「有知识含量」内容：课程、教程、教学、科普、纪录片、开箱测评、知识分享、技能讲解、历史/文化/科技解读等。
- isCourse 填 false 的「无知识含量」内容：纯音乐、纯搞笑段子、无解说游戏实况、直播聊天、新闻播报、普通网页、搜索页、社交页、邮箱、工作软件等。
- 若该视频属于已有学科之一，subject 必须与列表里某个已有名字完全一致；否则给一个简洁的新学科名（中文，≤8 字，如 机器学习/前端开发/英语/历史/数学/算法/美食测评）。
- title 为去掉浏览器与平台后缀后的纯视频标题。
- keywords 为 3~6 个核心知识点关键词。`
  let text = await llm.complete({ system, messages: [userMsg(user)], maxTokens })
  let cls = parseJson(text)
  if (!cls) {
    const retry = user + '\n\n（注意：上一次你的回复无法被解析。请严格只输出一个合法 JSON 对象本身，前后不要任何解释文字、不要 markdown 代码块、不要尾逗号。）'
    text = await llm.complete({ system, messages: [userMsg(retry)], maxTokens })
    cls = parseJson(text)
  }
  return cls
}

/** 生成知识地图 Markdown（含 Mermaid mindmap）。 */
export async function generate({ title, subject, keywords, content, llm, maxTokens = 4096, onToken }) {
  const system = '你是学习笔记整理专家，为视频课程生成「知识地图」（Markdown + Mermaid 思维导图）。'
  const safeTitle = mermaidSafe(title)
  let srcBlock = ''
  if (content) {
    const parts = []
    if (content.desc) parts.push('【视频简介】\n' + content.desc.slice(0, 800))
    if (content.tags?.length) parts.push('【视频标签】\n' + content.tags.join('、'))
    if (content.transcript) parts.push('【字幕/讲解文本（节选）】\n' + content.transcript.slice(0, 1500))
    if (content.danmaku?.length) parts.push('【弹幕（节选 ' + content.danmaku.length + ' 条）】\n' + content.danmaku.slice(0, 120).join('\n'))
    if (content.comments?.length) parts.push('【评论区热评（节选 ' + content.comments.length + ' 条）】\n' + content.comments.slice(0, 20).join('\n'))
    if (parts.length) srcBlock = '\n\n已抓取到以下视频真实内容/弹幕/评论，请基于它们总结（不要凭空编造）：\n\n' + parts.join('\n\n')
  }
  const head = [
    `视频标题：${title}`,
    `学科：${subject}`,
    `关键词：${keywords.join('、')}${srcBlock}`,
    '',
    '只返回 Markdown（不要任何解释、不要首尾多余说明），结构如下：',
    '',
    `## ${title}`,
    '',
    '> 一句话简介（概括本视频核心内容）',
    '',
    '### 核心知识点',
    '- **主题一**',
    '  - 要点',
    '  - 要点',
    '',
    '### 弹幕与评论讨论焦点',
    '- 观众关注/讨论的重点（1~3 条）',
    '',
    '### 思维导图',
  ].join('\n')
  const fence = ['```mermaid', 'mindmap', `  root((${safeTitle}))`, '    ...', '```'].join('\n')
  const tail = `要求：${content ? '优先基于抓取到的简介/字幕/弹幕/评论提炼真实知识点，不要编造。' : '基于标题与关键词合理推断、通用化。'}全部用中文；知识点 8~20 条、分 2~3 层；mermaid 用 mindmap 语法、2~3 层、节点文字避免括号等特殊字符。`
  const user = head + '\n' + fence + '\n\n' + tail
  return await llm.complete({ system, messages: [userMsg(user)], maxTokens, onToken })
}

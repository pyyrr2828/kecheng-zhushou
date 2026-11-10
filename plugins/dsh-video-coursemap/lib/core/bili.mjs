/** B 站抓取：标题 → 搜索反查 → 视频信息 / 弹幕 / 热评 / 字幕。失败一律抛错，由调用方降级。 */

export const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let cachedBuvid3 = null
async function getBuvid3() {
  if (cachedBuvid3 !== null) return cachedBuvid3
  try {
    const r = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'User-Agent': BILI_UA } })
    const j = await r.json()
    cachedBuvid3 = j?.data?.b_3 || ''
  } catch { cachedBuvid3 = '' }
  return cachedBuvid3
}

async function biliFetch(url, { json = true, timeoutMs = 10000, retries = 2 } = {}) {
  const buvid3 = await getBuvid3()
  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs)
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': BILI_UA,
          Referer: 'https://www.bilibili.com/',
          Accept: 'application/json, text/plain, */*',
          ...(buvid3 ? { Cookie: 'buvid3=' + buvid3 } : {}),
        },
        signal: ac.signal,
      })
      if (res.status === 412) throw new Error('HTTP 412')
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const text = await res.text()
      return json ? JSON.parse(text) : text
    } catch (e) {
      lastErr = e
      if (attempt < retries) await sleep(1500 * (attempt + 1))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr
}

function stripHtml(s) { return String(s || '').replace(/<[^>]+>/g, '').trim() }

function decodeXml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
}

function normTitle(s) { return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '') }

function titleSimilar(a, b) {
  const na = normTitle(a); const nb = normTitle(b)
  if (!na || !nb) return 0
  if (na.includes(nb) || nb.includes(na)) return 1
  const bigrams = (s) => { const m = new Set(); for (let i = 0; i < s.length - 1; i++) m.add(s.slice(i, i + 2)); return m }
  const A = bigrams(na); const B = bigrams(nb)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return (2 * inter) / (A.size + B.size)
}

export async function searchBili(title) {
  const url = 'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + encodeURIComponent(title)
  const data = await biliFetch(url)
  if (data?.code !== 0) throw new Error('bili search code ' + data?.code)
  const results = (data?.data?.result ?? []).filter((r) => r?.bvid)
  if (!results.length) return null
  // 首条常是合集/推广视频，相似度极低；在前 12 条里取最优，阈值放宽到 0.35。
  let best = null
  for (const r of results.slice(0, 12)) {
    const clean = stripHtml(r.title)
    const score = titleSimilar(title, clean)
    if (!best || score > best.score) best = { score, r, clean }
    if (best.score >= 0.85) break
  }
  if (!best || best.score < 0.35) return null
  const top = best.r
  return {
    bvid: top.bvid,
    aid: top.aid,
    title: best.clean,
    matchScore: Math.round(best.score * 100) / 100,
    desc: stripHtml(top.description || ''),
    tags: String(top.tag || '').split(',').map((s) => s.trim()).filter(Boolean),
  }
}

export async function viewBili(bvid) {
  const data = await biliFetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid))
  if (data?.code !== 0) throw new Error('bili view code ' + data?.code)
  const d = data?.data ?? {}
  return {
    aid: d.aid,
    cid: d.cid ?? d.pages?.[0]?.cid,
    desc: d.desc || '',
    owner: d.owner?.name || '',
    stat: d.stat || {},
    subtitle: d.subtitle?.list ?? [],
  }
}

export async function fetchDanmaku(cid) {
  if (!cid) return []
  const xml = await biliFetch('https://comment.bilibili.com/' + cid + '.xml', { json: false })
  const items = []
  const re = /<d[^>]*>([\s\S]*?)<\/d>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const t = decodeXml(m[1]).trim()
    if (!t) continue
    if (t.startsWith('[') && t.endsWith(']')) continue
    items.push(t)
  }
  const seen = new Set()
  return items.filter((t) => { if (seen.has(t)) return false; seen.add(t); return true }).slice(0, 150)
}

export async function fetchComments(aid) {
  if (!aid) return []
  const data = await biliFetch('https://api.bilibili.com/x/v2/reply?type=1&oid=' + aid + '&sort=2&ps=20&pn=1')
  if (data?.code !== 0) throw new Error('bili reply code ' + data?.code)
  return (data?.data?.replies ?? []).map((r) => String(r?.content?.message || '').trim()).filter(Boolean).slice(0, 20)
}

export async function fetchSubtitle(view) {
  const list = view?.subtitle ?? []
  if (!list.length) return ''
  let u = list[0]?.subtitle_url
  if (!u) return ''
  if (u.startsWith('//')) u = 'https:' + u
  const data = await biliFetch(u, { json: true })
  return (data?.body ?? []).map((b) => String(b?.content || '').trim()).filter(Boolean).join(' ')
}

/** 综合抓取：返回 null 表示未能识别（调用方降级为仅标题总结）。 */
export async function fetchBiliContent(title) {
  const s = await searchBili(title)
  if (!s) return null
  let view = null
  try { view = await viewBili(s.bvid) } catch { /* 忽略 */ }
  const cid = view?.cid
  const aid = view?.aid || s.aid
  const [danmaku, comments] = await Promise.allSettled([
    cid ? fetchDanmaku(cid) : Promise.resolve([]),
    aid ? fetchComments(aid) : Promise.resolve([]),
  ])
  let transcript = ''
  try { transcript = await fetchSubtitle(view) } catch { /* 忽略 */ }
  return {
    bvid: s.bvid,
    aid,
    cid,
    matchScore: s.matchScore,
    desc: String(view?.desc || s.desc || '').trim(),
    tags: s.tags || [],
    owner: view?.owner || '',
    stat: view?.stat || {},
    transcript,
    danmaku: danmaku.status === 'fulfilled' ? danmaku.value : [],
    comments: comments.status === 'fulfilled' ? comments.value : [],
  }
}

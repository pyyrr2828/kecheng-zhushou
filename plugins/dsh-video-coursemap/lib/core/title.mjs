/** 标题清洗与进程判定：从浏览器/客户端的窗口标题里还原视频名。 */

export const BROWSER_PROCESSES = new Set([
  'chrome', 'msedge', 'edge', 'firefox', 'iexplore', 'opera', 'brave', 'chromium',
  'vivaldi', 'yandex', 'librewolf', 'waterfox',
  '360chrome', '360se', '360browser', 'qqbrowser', 'sogouexplorer', 'maxthon', 'ucbrowser', 'quark', '夸克',
  'bilibili', '哔哩哔哩',
  'douyin', '抖音', 'aweme',
  'kuaishou', '快手',
  'xigua', '西瓜视频',
  'youku', '优酷', 'iqiyi', '爱奇艺', 'pps',
  'qqlive', 'tencentvideo', '腾讯视频',
  'mgtv', '芒果tv', '芒果TV',
  'migu', '咪咕视频',
  'weishi', '微视',
  'sohuvideo', '搜狐视频', 'letv', '乐视',
  'potplayer', 'vlc', 'mpv', 'kmplayer', 'mpc-hc', 'mpc-be',
])

export const TITLE_SUFFIXES = [
  ' - Google Chrome', ' - Microsoft Edge', ' - Mozilla Firefox',
  ' - Chromium', ' - Opera', ' - Brave', ' - Internet Explorer',
  ' - 谷歌浏览器', ' - 微软 Edge', ' - 火狐浏览器', ' - 360极速浏览器',
  '_哔哩哔哩_bilibili', '_哔哩哔哩', ' - 哔哩哔哩', ' - bilibili', '-bilibili', ' - Bilibili',
  ' - YouTube', ' - 优酷', ' - 爱奇艺', ' - 腾讯视频', ' - 芒果TV', ' - 抖音', ' - 快手', ' - 夸克', ' - Quark',
]

const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\ufeff]/g

/**
 * 去掉浏览器/平台后缀，得到纯视频标题。
 * 浏览器会在页面标题后追加「- <profile> - <浏览器>」，B 站标题自带
 * 「_哔哩哔哩_bilibili」；只按后缀表剥离会残留「- 个人」，标题里仍有平台名，
 * 会被「B 站首页」判断整条漏掉（Edge 多 profile 下必现）。
 */
export function cleanTitle(raw) {
  let t = String(raw || '').replace(ZERO_WIDTH, '').trim()
  let changed = true
  while (changed) {
    changed = false
    for (const suf of TITLE_SUFFIXES) {
      if (t.endsWith(suf)) { t = t.slice(0, -suf.length).trim(); changed = true }
    }
    if (/哔哩哔哩|bilibili|youtube|优酷|爱奇艺|腾讯视频/i.test(t)) {
      const m = t.match(/^(.*?)\s+-\s+[^-]{1,24}$/)
      if (m) { t = m[1].trim(); changed = true }
    }
  }
  return t
}

export function isBrowserProc(proc) {
  return BROWSER_PROCESSES.has(String(proc || '').toLowerCase().replace(/\.exe$/i, ''))
}

/** 判断标题是否只是平台首页/搜索页（非具体视频）。 */
export function isPlatformHome(cleaned) {
  return /哔哩哔哩|bilibili/i.test(String(cleaned || ''))
}

export function sanitizeSubject(s) {
  return String(s || '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').slice(0, 60) || '未分类'
}

export function mermaidSafe(s) {
  return String(s || '').replace(/[()[\]{}|<>'`\\/]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
}

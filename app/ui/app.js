/* 课程助手 前端（原生 JS，无构建） */
const $ = (id) => document.getElementById(id);
const state = { status: null, feed: [], current: null, onlyIssues: false, activeSubject: null };

/* ---------- 极简 Markdown 渲染（先转义，再白名单标签） ---------- */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(text) {
  let s = esc(text);
  s = s.replace(/\u0060([^\u0060]+)\u0060/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s;
}

const FENCE = /^\u0060\u0060\u0060/;

function mdToHtml(md) {
  const lines = String(md || '').replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let code = null, list = false, quote = false;
  const closeList = () => { if (list) { out.push('</ul>'); list = false; } };
  const closeQuote = () => { if (quote) { out.push('</blockquote>'); quote = false; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (code !== null) {
      if (FENCE.test(line.trim())) { out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code = null; }
      else code.push(line);
      continue;
    }
    if (FENCE.test(line.trim())) { closeList(); closeQuote(); code = []; continue; }
    if (!line.trim()) { closeList(); closeQuote(); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList(); closeQuote();
      out.push('<' + 'h' + h[1].length + '>' + inline(h[2]) + '</' + 'h' + h[1].length + '>');
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { closeList(); closeQuote(); out.push('<hr />'); continue; }
    if (/^>\s?/.test(line)) {
      closeList();
      if (!quote) { out.push('<blockquote>'); quote = true; }
      out.push(inline(line.replace(/^>\s?/, '')) + '<br />');
      continue;
    }
    const li = line.match(/^\s*[-*+]\s+(.*)$/);
    if (li) {
      closeQuote();
      if (!list) { out.push('<ul>'); list = true; }
      out.push('<li>' + inline(li[1]) + '</li>');
      continue;
    }
    closeList(); closeQuote();
    out.push('<p>' + inline(line) + '</p>');
  }
  if (code !== null) out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
  closeList(); closeQuote();
  return out.join('\n');
}

/* ---------- 状态渲染 ---------- */
const VERDICT = {
  pending: ['pending', '待确认'],
  seen: ['seen', '已处理·静默'],
  'ignored-proc': ['ignored-proc', '非浏览器'],
  'platform-home': ['platform-home', 'B站首页'],
  'too-short': ['too-short', '标题太短'],
  'not-course': ['seen', '非课程·静默'],
  busy: ['warn', '排队中'],
};

function setDot(kind) {
  $('dot').className = 'dot ' + (kind === 'on' ? 'on' : kind === 'err' ? 'err' : 'off');
}

function renderStatus(s) {
  if (!s) return;
  state.status = s;
  setDot(s.enabled ? 'on' : 'off');
  $('toggle').checked = !!s.enabled;
  $('toggleText').textContent = s.enabled ? '运行中' : '已停止';
  const sel = $('interval');
  const v = String(s.intervalMs);
  if (![...sel.options].some((o) => o.value === v)) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = (s.intervalMs / 1000) + ' 秒';
    sel.appendChild(opt);
  }
  sel.value = v;
  $('outDir').value = s.outputDir || '';
  $('stablePolls').value = s.stablePolls || 2;
  if (s.llm) {
    $('baseUrl').value = s.llm.baseUrl || '';
    $('model').value = s.llm.model || '';
    $('keyHint').textContent = s.llm.configured ? ('已配置 ' + (s.llm.keyHint || '')) : '留空则只检测不生成笔记';
    const banner = $('banner');
    if (!s.llm.configured) {
      banner.className = 'banner show';
      banner.innerHTML = '未配置模型：当前只检测、不生成笔记。 <a id="goSettings">去设置</a>';
      $('goSettings').onclick = openSettings;
    } else {
      banner.className = 'banner';
    }
  }
  renderChips(s);
}

function renderChips(s) {
  const box = $('chips');
  box.innerHTML = '';
  if (!s.docs || !s.docs.length) {
    box.innerHTML = '<span style="color:var(--muted)">笔记库：暂无学科</span>';
    return;
  }
  for (const d of s.docs) {
    const el = document.createElement('button');
    el.className = 'chip' + (state.activeSubject === d.subject ? ' active' : '');
    el.innerHTML = esc(d.subject) + '<small>' + d.videos + ' 个视频</small>';
    el.onclick = () => loadSubject(d.subject);
    box.appendChild(el);
  }
}

/* ---------- 轮询事件 ---------- */
function fmtTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

let curEventAt = 0;

function addRow(tagClass, tagText, mainText, subText, at) {
  state.feed.push({ tagClass: tagClass, tagText: tagText, mainText: mainText, subText: subText, at: fmtTime(at || curEventAt) });
  if (state.feed.length > 200) state.feed.shift();
  drawFeed();
}

function drawFeed() {
  const feed = $('feed');
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  const rows = state.feed.filter((r) => !state.onlyIssues || /err|warn/.test(r.tagClass));
  if (!rows.length) {
    feed.innerHTML = '<div class="empty">等待第一次轮询…<br />把 B 站课程视频放在前台即可</div>';
    return;
  }
  feed.innerHTML = rows.map((r) => '<div class="row"><time>' + r.at + '</time><div>'
    + '<div class="main-line"><span class="tag ' + r.tagClass + '">' + esc(r.tagText) + '</span>'
    + '<span class="title-text">' + esc(r.mainText) + '</span></div>'
    + (r.subText ? '<div class="sub-text">' + esc(r.subText) + '</div>' : '')
    + '</div></div>').join('');
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

function stepBar(steps) {
  const names = [['classify', '分类'], ['fetch', '抓取'], ['generate', '生成'], ['docx', '出 Word']];
  return '<div class="steps">' + names.map((pair) => {
    const st = steps[pair[0]] || '';
    return '<span class="step ' + st + '">' + pair[1] + '</span>';
  }).join('') + '</div>';
}

function showCard(card) {
  const box = $('summary');
  box.innerHTML = '<div class="sum-title">' + esc(card.title || '处理中') + '</div>'
    + '<div class="sum-sub">' + esc(card.subject ? '学科：' + card.subject : '') + '</div>'
    + stepBar(card.steps || {})
    + '<div id="stream" style="display:' + (card.stream ? 'block' : 'none') + '">' + esc(card.stream || '') + '</div>'
    + '<div class="md" id="md">' + (card.markdown || '') + '</div>'
    + '<div id="cardExtra">' + (card.extra || '') + '</div>'
    + '<div class="actions" id="cardActions"></div>';
  if (card.onReady) card.onReady();
  const act = $('cardActions');
  for (const a of card.actions || []) {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.onclick = a.onClick;
    act.appendChild(b);
  }
}

function openPath(p) {
  fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) })
    .then((r) => r.json())
    .then((j) => { if (!j.ok) alert(j.message || '打开失败'); })
    .catch((e) => alert('打开失败：' + e.message));
}

function dirOf(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : p;
}

async function loadSubject(subject) {
  state.activeSubject = subject;
  renderChips(state.status);
  try {
    const r = await fetch('/api/notes/' + encodeURIComponent(subject));
    const j = await r.json();
    if (!j.ok) { alert(j.message || '没有该学科的笔记'); return; }
    const docx = j.docx || null;
    const videos = j.videos || [];
    const actions = [];
    if (docx) actions.push({ label: '打开 Word', onClick: () => openPath(docx) });
    if (docx) actions.push({ label: '打开目录', onClick: () => openPath(dirOf(docx)) });
    actions.push({ label: '重建 Word', onClick: () => rebuildSubject(subject) });
    actions.push({ label: '删除本学科', onClick: () => deleteSubject(subject, videos.length) });

    const extra = videos.length
      ? '<div class="vlist"><div class="vhead">本学科的视频（可单独删除）</div>'
        + videos.map((v, i) => '<div class="vrow"><span class="vtitle" title="' + esc(v.title) + '">' + esc(v.title) + '</span>'
          + '<button class="vdel" data-i="' + i + '">删除</button></div>').join('')
        + '</div>'
      : '';

    showCard({
      title: subject,
      subject: '共 ' + videos.length + ' 个视频',
      steps: { classify: 'done', fetch: 'done', generate: 'done', docx: docx ? 'done' : '' },
      markdown: mdToHtml(j.markdown),
      actions: actions,
      extra: extra,
      onReady: () => {
        document.querySelectorAll('.vdel').forEach((btn) => {
          btn.onclick = () => deleteVideo(subject, videos[Number(btn.dataset.i)].title);
        });
      },
    });
  } catch (e) {
    alert('加载失败：' + e.message);
  }
}

async function deleteVideo(subject, title) {
  if (!confirm('删除这一章？\n\n' + title + '\n\n只从这本手册里移除，Word 会同步重建。')) return;
  const res = await post('/api/notes/' + encodeURIComponent(subject) + '/delete-video', { title: title });
  if (!res.ok) return alert('删除失败：' + (res.data.message || ''));
  addRow('seen', '已删除', title, '学科 ' + subject);
  await fetchStatus();
  await loadSubject(subject);
}

async function deleteSubject(subject, count) {
  if (!confirm('删除整个学科「' + subject + '」？\n\n会删掉 ' + count + ' 个视频的笔记、md 源和 Word；\n去重记录也会清掉（以后再看会重新生成）。')) return;
  const res = await post('/api/notes/' + encodeURIComponent(subject) + '/delete', {});
  if (!res.ok) return alert('删除失败：' + (res.data.message || ''));
  addRow('seen', '已删除', '学科 ' + subject, count + ' 个视频');
  state.activeSubject = null;
  state.current = null;
  $('summary').innerHTML = '<div class="empty">已删除「' + esc(subject) + '」。识别到课程后这里会重新显示内容</div>';
  if (res.data.status) renderStatus(res.data.status);
  else await fetchStatus();
}

async function rebuildSubject(subject) {
  const res = await post('/api/notes/' + encodeURIComponent(subject) + '/rebuild', {});
  if (!res.ok) return alert('重建失败：' + (res.data.message || ''));
  addRow('ok', '重建', 'Word 已按 md 重新生成', '学科 ' + subject);
}

function onEvent(e) {
  curEventAt = e.at || Date.now();
  switch (e.type) {
    case 'tick':
      addRow('tick', '轮询', e.proc + '  ' + (e.title || '(空标题)'), '');
      if (state.status && state.status.intervalMs) state.status.nextTickAt = curEventAt + state.status.intervalMs;
      break;
    case 'decision': {
      const pair = VERDICT[e.verdict] || ['', e.verdict];
      const extra = e.verdict === 'pending' ? ' ' + e.stable + '/' + e.need : '';
      addRow(pair[0], pair[1] + extra, e.cleaned || e.proc || '', '');
      break;
    }
    case 'classify':
      addRow('ok', '分类', e.subject || '(未定)', e.isCourse ? '判定为课程' : '判定为非课程');
      state.current = { title: e.title, subject: e.subject, steps: { classify: 'done' } };
      showCard(state.current);
      break;
    case 'fetch':
      addRow(e.bvid ? 'ok' : 'warn', '抓取', e.bvid ? ('bvid ' + e.bvid) : '未匹配到视频（仅按标题总结）',
        e.bvid ? ('弹幕 ' + e.danmaku + ' · 评论 ' + e.comments + ' · 字幕 ' + (e.transcript ? '有' : '无')) : '');
      if (state.current) {
        state.current.steps.fetch = 'done';
        showCard(state.current);
      }
      break;
    case 'generate-start':
      addRow('pending', '生成中', e.title, '学科：' + e.subject);
      state.current = { title: e.title, subject: e.subject, steps: { classify: 'done', fetch: 'done', generate: 'active' }, stream: '' };
      showCard(state.current);
      break;
    case 'token':
      if (state.current && state.current.stream !== undefined) {
        state.current.stream += e.text;
        const s = $('stream');
        if (s) { s.style.display = 'block'; s.textContent = state.current.stream.slice(-2000); s.scrollTop = s.scrollHeight; }
      }
      break;
    case 'generate-done':
      addRow('ok', '完成', e.title, (e.isNewSubject ? '新学科 → ' : '已更新学科 → ') + (e.docx || '(Word 未生成)'));
      if (state.current) {
        state.current.steps = { classify: 'done', fetch: 'done', generate: 'done', docx: e.docxOk ? 'done' : '' };
        delete state.current.stream;
      }
      fetchStatus().then(() => loadSubject(e.subject));
      break;
    case 'error':
      addRow('err', e.code || '错误', e.message || '', '');
      if (e.code === 'LLM_AUTH' || e.code === 'NO_LLM') {
        $('banner').className = 'banner show';
        $('banner').innerHTML = '模型调用失败：' + esc(e.message || '') + ' <a id="goSettings2">去设置</a>';
        const g = $('goSettings2');
        if (g) g.onclick = openSettings;
      }
      break;
    case 'skipped':
      addRow('warn', '跳过', '另一个实例正在运行', '请退出 DSH 里的插件或另一个应用实例');
      break;
    case 'status':
      renderStatus(e);
      break;
    default:
      break;
  }
}

/* ---------- 状态与交互 ---------- */
async function fetchStatus() {
  try {
    const r = await fetch('/api/status');
    renderStatus(await r.json());
  } catch {
    setDot('err');
  }
}

function openSettings() {
  $('drawer').className = 'open';
  if (state.status) {
    $('baseUrl').value = state.status.llm.baseUrl;
    $('model').value = state.status.llm.model;
    $('apiKey').value = '';
    $('apiKey').placeholder = state.status.llm.configured ? '已配置，留空表示不修改' : 'sk-...';
  }
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data: data };
}

$('saveInterval').onclick = async () => {
  const ms = Number($('interval').value);
  const res = await post('/api/config', { pollIntervalMs: ms });
  if (!res.ok) return alert((res.data.errors || [res.data.message]).join('\n'));
  renderStatus(res.data.status);
  addRow('ok', '设置', '轮询间隔已改为 ' + (ms / 1000) + ' 秒', '');
};

$('toggle').onchange = async (ev) => {
  const enabled = ev.target.checked;
  const res = await post('/api/config', { enabled: enabled });
  if (!res.ok) { ev.target.checked = !enabled; return alert((res.data.errors || [res.data.message]).join('\n')); }
  renderStatus(res.data.status);
  addRow(enabled ? 'ok' : 'seen', enabled ? '已启动' : '已停止', '轮询' + (enabled ? '恢复' : '暂停'), '');
};

$('scan').onclick = async () => {
  const res = await post('/api/scan', {});
  if (!res.ok) alert(res.data.message || '扫描失败');
  else addRow('pending', '手动', res.data.message, '');
};

$('onlyIssues').onclick = () => {
  state.onlyIssues = !state.onlyIssues;
  $('onlyIssues').classList.toggle('primary', state.onlyIssues);
  drawFeed();
};

$('clearFeed').onclick = () => { state.feed = []; drawFeed(); };

$('openIndex').onclick = () => {
  const p = state.status && state.status.indexDocx;
  if (!p) return alert('还没有生成课程总览');
  openPath(p);
};

$('openSettings').onclick = openSettings;
$('closeSettings').onclick = () => { $('drawer').className = ''; };

$('saveSettings').onclick = async () => {
  const payload = {
    llm: { baseUrl: $('baseUrl').value.trim(), model: $('model').value.trim() },
    stablePolls: Number($('stablePolls').value),
  };
  const key = $('apiKey').value.trim();
  if (key) payload.llm.apiKey = key;
  const res = await post('/api/config', payload);
  if (!res.ok) return alert((res.data.errors || [res.data.message]).join('\n'));
  renderStatus(res.data.status);
  $('drawer').className = '';
  addRow('ok', '设置', '已保存', '模型：' + (res.data.status.llm.model || ''));
};

$('testLlm').onclick = async () => {
  const llm = { baseUrl: $('baseUrl').value.trim(), model: $('model').value.trim() };
  const key = $('apiKey').value.trim();
  if (key) llm.apiKey = key;
  const btn = $('testLlm');
  btn.disabled = true;
  btn.textContent = '测试中…';
  const res = await post('/api/llm/test', { llm: llm });
  btn.disabled = false;
  btn.textContent = '测试连接';
  alert(res.ok ? '连接正常，模型回复：' + (res.data.reply || '') : '失败：' + (res.data.message || ''));
};

$('resetSeen').onclick = async () => {
  if (!confirm('清空去重表后，同一视频会重新处理一遍。继续？')) return;
  await post('/api/seen/reset', {});
  alert('已清空');
};

setInterval(() => {
  const s = state.status;
  const el = $('countdown');
  if (!s || !s.enabled || !s.nextTickAt) { el.innerHTML = '下次轮询 <b>--:--</b>'; return; }
  const left = Math.max(0, s.nextTickAt - Date.now());
  const mm = String(Math.floor(left / 60000)).padStart(2, '0');
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
  el.innerHTML = '下次轮询 <b>' + mm + ':' + ss + '</b>';
}, 1000);

let lastEventId = 0;

(async function boot() {
  await fetchStatus();
  const es = new EventSource('/api/events');
  es.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data);
      if (e.id && e.id <= lastEventId) return;
      if (e.id) lastEventId = e.id;
      onEvent(e);
    } catch (err) { /* 忽略 */ }
  };
  es.onerror = () => setDot('err');
  setInterval(fetchStatus, 15000);
})();

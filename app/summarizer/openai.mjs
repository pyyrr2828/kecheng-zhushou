/** OpenAI 兼容的模型适配器（DeepSeek 官方 / 任意兼容端点 / Ollama）。 */

export function createOpenAILLM({ baseUrl, apiKey, model, timeoutMs = 120000 }) {
  return {
    configured: Boolean(apiKey),
    async complete({ system, messages, maxTokens, onToken }) {
      if (!apiKey) {
        const err = new Error('未配置 API Key')
        err.code = 'NO_LLM'
        throw err
      }
      const url = String(baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '') + '/chat/completions'
      const body = {
        model: model || 'deepseek-chat',
        stream: true,
        max_tokens: maxTokens ?? 4096,
        messages: [
          { role: 'system', content: system },
          ...messages.map((m) => ({ role: m.role, content: (m.content || []).map((c) => c.text ?? '').join('') })),
        ],
      }
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs)
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
          body: JSON.stringify(body),
          signal: ac.signal,
        })
        if (!res.ok) {
          const text = (await res.text()).slice(0, 300)
          const err = new Error(`模型接口 ${res.status}：${text}`)
          err.code = res.status === 401 || res.status === 403 ? 'LLM_AUTH' : 'LLM_HTTP'
          throw err
        }
        const ctype = res.headers.get('content-type') || ''
        if (!ctype.includes('text/event-stream')) {
          const j = await res.json()
          const text = j?.choices?.[0]?.message?.content ?? ''
          if (text && onToken) onToken(text)
          return text
        }
        let text = ''
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            const s = line.trim()
            if (!s.startsWith('data:')) continue
            const payload = s.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
              const j = JSON.parse(payload)
              const d = j?.choices?.[0]?.delta?.content
              if (d) { text += d; if (onToken) onToken(d) }
            } catch { /* 忽略非 JSON 行 */ }
          }
        }
        return text
      } catch (e) {
        if (e?.name === 'AbortError' || /timeout/i.test(e?.message ?? '')) {
          const err = new Error('模型调用超时（120s）')
          err.code = 'LLM_TIMEOUT'
          throw err
        }
        throw e
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

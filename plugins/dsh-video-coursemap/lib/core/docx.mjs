/** Markdown → Word：调用插件自带 scripts/md2docx.py，Python 优先用 DSH 捆绑运行时。 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MD2DOCX_PATH = join(HERE, '..', '..', 'scripts', 'md2docx.py')

/** 找一个可用 Python：DSH 捆绑运行时优先，其次 PATH。 */
export function findPython() {
  const cands = []
  const runtimesDir = join(homedir(), '.dsh', 'dsh-runtimes')
  try {
    for (const rt of readdirSync(runtimesDir)) {
      cands.push(join(runtimesDir, rt, 'dependencies', 'python', 'python.exe'))
    }
  } catch { /* 忽略 */ }
  cands.push('python', 'python3')
  for (const c of cands) {
    try {
      const r = spawnSync(c, ['--version'], { timeout: 8000, windowsHide: true })
      if (r.status === 0) return c
    } catch { /* 忽略 */ }
  }
  return 'python'
}

/** 把 md 转成 docx；失败抛出（调用方决定降级）。 */
export function convertToDocx(pythonPath, mdPath, docxPath) {
  if (!existsSync(MD2DOCX_PATH)) throw new Error(`缺少 md2docx.py：${MD2DOCX_PATH}`)
  mkdirSync(dirname(docxPath), { recursive: true })
  const r = spawnSync(pythonPath, [MD2DOCX_PATH, mdPath, docxPath], { timeout: 60000, windowsHide: true, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`md2docx 转换失败（${pythonPath}）：${String(r.stderr || r.stdout || '').trim().slice(0, 400)}`)
}

/** 读取 Windows 前台窗口（进程名 + 标题）。结果先写文件再读，规避 stdout 编码差异。 */
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { dirname } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'

const execFileP = promisify(execFile)

export const POLL_PS1 = `param([string]$OutFile)
Add-Type -ErrorAction SilentlyContinue @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FGWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$h = [FGWin]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][FGWin]::GetWindowText($h, $sb, 512)
$procId = 0
[void][FGWin]::GetWindowThreadProcessId($h, [ref]$procId)
$pname = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
$text = "TITLE=" + $sb.ToString() + "\`nPROC=" + $pname
[System.IO.File]::WriteAllText($OutFile, $text, (New-Object System.Text.UTF8Encoding($false)))
`

let ps1Path = null
let outPath = null

/** 初始化脚本落盘位置（应在输出目录的 .state 下）。 */
export function initPollScript(stateDir) {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
  ps1Path = `${stateDir}/poll.ps1`
  outPath = `${stateDir}/poll-out.txt`
  writeFileSync(ps1Path, POLL_PS1, 'utf8')
}

/** @returns {Promise<{title:string, proc:string}|null>} */
export async function readForeground({ timeoutMs = 8000 } = {}) {
  if (!ps1Path) throw new Error('readForeground: 先调用 initPollScript(stateDir)')
  try {
    await execFileP('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', ps1Path, '-OutFile', outPath,
    ], { timeout: timeoutMs, windowsHide: true })
    const txt = readFileSync(outPath, 'utf8').replace(/^\uFEFF/, '')
    const title = (txt.match(/^TITLE=(.*)$/m)?.[1] ?? '').trim()
    const proc = (txt.match(/^PROC=(.*)$/m)?.[1] ?? '').trim()
    return { title, proc }
  } catch { return null }
}

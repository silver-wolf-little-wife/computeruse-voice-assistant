/**
 * 显存探测：读一眼显卡的显存占用。
 *
 * 为什么走 nvidia-smi：
 *   - DXGI 要在渲染进程里跑，主进程没有；
 *   - WMI 的 Win32_VideoController 只有总量，没有"已用"；
 *   - nvidia-smi 是驱动自带的，Windows 上就在 System32 里，一次调用 40~100ms；
 *   - 笔记本混合显卡下它报的是独显，而独显才是真正被游戏/模型吃掉的那张。
 *
 * 拿不到就返回 null（AMD/Intel 独显、没装驱动、驱动版本太老都可能）。
 * 资源策略把 null 当"没有显存数据"，只按全屏/内存判断——读不到数据时宁可不动语音，
 * 也不要凭空把 TTS worker 关掉。
 */
import { execFile } from 'node:child_process'

const TIMEOUT_MS = 2000
/** 有的机器 nvidia-smi 不在 PATH 里，但默认装在这里 */
const FALLBACK_EXE = 'C:\\Windows\\System32\\nvidia-smi.exe'

/**
 * 解析 `--query-gpu=memory.total,memory.used --format=csv,noheader,nounits` 的输出。
 *
 * 多卡时取显存最大的那张（游戏/渲染吃的是它）；脏数据整行跳过。
 * 导出给验收脚本用。
 */
export function parseVram(text) {
  const rows = String(text ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')
  let best = null
  for (const row of rows) {
    const cells = row.split(',')
    if (cells.length < 2) continue
    const total = Number(cells[0].trim())
    const used = Number(cells[1].trim())
    if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0 || used < 0) continue
    if (best === null || total > best.totalMb) best = { totalMb: total, usedMb: Math.min(used, total) }
  }
  return best
}

function runSmi(exe, args) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout: TIMEOUT_MS }, (error, stdout) => {
      if (error !== null) {
        resolve(null)
        return
      }
      resolve(parseVram(stdout))
    })
  })
}

/**
 * 当前显存占用 `{ totalMb, usedMb }`；拿不到返回 null。
 * 只是"看一眼"，不缓存——20 秒才调一次，省下那次查表不值得多养一份状态。
 */
export async function queryVram() {
  const args = ['--query-gpu=memory.total,memory.used', '--format=csv,noheader,nounits']
  const primary = await runSmi('nvidia-smi', args)
  if (primary !== null) return primary
  return runSmi(FALLBACK_EXE, args)
}

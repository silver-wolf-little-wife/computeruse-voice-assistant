/**
 * 资源策略（R14）：什么时候该把模型"让"出来。
 *
 * 背景：TTS worker 常驻 1.5GB 显存、ASR 常驻 240MB 内存。
 * 用户打游戏（全屏）时这两块就是纯占用——游戏掉帧的第一嫌疑。
 *
 * 两档动作，都只做"可逆的让路"，不牺牲唤醒能力：
 *   release-voice  全屏应用占满屏幕 → 关掉 TTS worker（释放显存），唤醒与识别照旧
 *   release-asr    可用内存低于阈值 → 卸掉 ASR（240MB），但**保留 KWS**（3.3MB），
 *                  所以唤醒词仍然有效，只是唤醒了要多等 6 秒加载识别模型
 *
 * 为什么保留 KWS：唤醒是"这个软件还在"的唯一证据。为了省 3MB 把唤醒也关了，
 * 用户只会觉得软件死了。
 */

export const RESOURCE_DEFAULTS = {
  /** 前台窗口覆盖工作区超过这个比例就算"全屏遮挡"（边框全屏游戏常见 1.0，最大化约 1.0 也扣掉任务栏） */
  fullscreenRatio: 0.98,
  /** 可用内存低于多少 MB 时卸 ASR */
  memoryFloorMb: 1200,
  /** 全屏判定额外要求：窗口高度接近屏幕高度（防止横向铺满但只占一半的情况） */
  minHeightRatio: 0.95,
  pollMs: 20000,
  /**
   * 显存剩余低于这个 MB 就让出 TTS。
   *
   * 为什么要显存阈值：8GB 卡上 TTS worker 常驻 1.5GB，打游戏时它是纯占用；
   * 而"全屏"这一条抓不住窗口化/无边框窗口的游戏（星铁窗口 1295x757 只占 54% 屏幕）。
   * 800MB 在 8GB 卡上约等于剩余 10%，再往下游戏就开始掉帧。
   */
  vramFloorMb: 800,
  /** 显存占用高于这个比例也让出（大显存卡上 vramFloorMb 可能永远不触发） */
  vramHighRatio: 0.85,
  /** 占用回到这个比例以下才算"不紧张"，才恢复语音（留回差，避免来回抖） */
  vramLowRatio: 0.6,
  /**
   * 显存触发的让路最多持续这么久，到点自动恢复语音。
   *
   * 用户不会记得去托盘取消；显存被别的程序长期占着（游戏/OBS/本地模型）时，
   * 语音就永久哑了。10 分钟后先恢复，真紧张的话等显存回落再重新让路。
   */
  vramReleaseMaxMs: 10 * 60 * 1000,
}

/** 显存占用比例；没有数据返回 null */
export function vramRatio(vram) {
  const total = Number(vram?.totalMb)
  const used = Number(vram?.usedMb)
  if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0 || used < 0) return null
  return Math.min(1, used / total)
}

/**
 * 显存紧不紧张。
 * @returns {boolean|null} null = 没有显存数据（不是 N 卡，或读不到），当不紧张处理
 */
export function vramPressure(vram, options = {}) {
  const cfg = { ...RESOURCE_DEFAULTS, ...options }
  const ratio = vramRatio(vram)
  if (ratio === null) return null
  const freeMb = Number(vram.totalMb) - Number(vram.usedMb)
  return ratio >= cfg.vramHighRatio || freeMb < cfg.vramFloorMb
}

/**
 * 覆盖比例：用**整块显示器**（rcMonitor）而不是工作区来算。
 *
 * 为什么：最大化窗口正好等于工作区（1.0），如果按工作区算，用户平常"浏览器最大化"
 * 就会被当成全屏游戏，语音一直被关掉。真正的全屏游戏会盖住任务栏、等于整块显示器。
 * 数据里没有 monW/monH 时退回工作区（老版本探测脚本的兼容）。
 */
export function coverageRatio(view) {
  if (view === null || typeof view !== 'object') return 0
  const baseX = view.monLeft ?? view.screenLeft
  const baseY = view.monTop ?? view.screenTop
  const baseW = view.monW ?? view.screenW
  const baseH = view.monH ?? view.screenH
  if (!(baseW > 0) || !(baseH > 0)) return 0
  const width = Math.max(0, Math.min(view.right, baseX + baseW) - Math.max(view.left, baseX))
  const height = Math.max(0, Math.min(view.bottom, baseY + baseH) - Math.max(view.top, baseY))
  return (width * height) / (baseW * baseH)
}

/** 是否处于"全屏遮挡"状态 */
export function isFullscreen(info, options = {}) {
  const cfg = { ...RESOURCE_DEFAULTS, ...options }
  if (info === null || typeof info !== 'object') return false
  if (typeof info.title !== 'string' || info.title === '') return false
  // 任务栏/桌面这类不算游戏
  const exempt = new Set(['explorer', 'ShellExperienceHost', 'SearchHost', 'StartMenuExperienceHost'])
  if (exempt.has(String(info.process ?? ''))) return false
  const ratio = coverageRatio(info)
  const baseY = info.monTop ?? info.screenTop
  const baseH = info.monH ?? info.screenH
  const heightRatio = (info.bottom - info.top) / Math.max(1, baseH)
  // 高度也要占满：横向铺满但只占半屏的情况（分屏）不算
  return ratio >= cfg.fullscreenRatio && heightRatio >= cfg.minHeightRatio && baseY !== undefined
}

/**
 * 决策。
 * @param {{fullscreen:boolean, freeMemMb:number, voiceLoaded:boolean, asrLoaded:boolean, busy:boolean, vram:({totalMb:number,usedMb:number}|null)}} state
 *   busy = 正在对话/播报/等确认 —— 这时候一律不动
 * @returns {{releaseVoice:boolean, releaseAsr:boolean, vramPressure:boolean|null, vramForced:boolean, reason:string}}
 *   vramForced = 这次让路是显存触发的（不是全屏），决定"什么时候恢复"和"10 分钟到点恢复"用
 */
export function decide(state, options = {}) {
  const cfg = { ...RESOURCE_DEFAULTS, ...options }
  const { fullscreen = false, freeMemMb = Infinity, voiceLoaded = false, asrLoaded = false, busy = false, vram = null } = state ?? {}
  const pressure = vramPressure(vram, cfg) === true
  const ratio = vramRatio(vram)

  if (busy) return { releaseVoice: false, releaseAsr: false, vramPressure: pressure, vramForced: false, reason: 'busy' }

  const needsVoiceRelease = (fullscreen || pressure) && voiceLoaded
  const needsAsrRelease = freeMemMb < cfg.memoryFloorMb && asrLoaded
  if (!needsVoiceRelease && !needsAsrRelease) {
    return { releaseVoice: false, releaseAsr: false, vramPressure: pressure, vramForced: false, reason: 'ok' }
  }
  const parts = []
  if (fullscreen && voiceLoaded) parts.push('全屏应用占满屏幕 → 释放 TTS 显存')
  if (pressure && voiceLoaded && !fullscreen) {
    parts.push(`显存 ${Math.round(vram.usedMb)}/${Math.round(vram.totalMb)}MB（${Math.round((ratio ?? 0) * 100)}%）吃紧 → 释放 TTS 显存`)
  }
  if (needsAsrRelease) parts.push(`可用内存 ${Math.round(freeMemMb)}MB < ${cfg.memoryFloorMb}MB → 卸载 ASR（保留唤醒）`)
  return {
    releaseVoice: needsVoiceRelease,
    releaseAsr: needsAsrRelease,
    vramPressure: pressure,
    vramForced: needsVoiceRelease && !fullscreen,
    reason: parts.join('；'),
  }
}

/**
 * 强制恢复之后，什么时候重新允许自动让路。
 *
 * 必须和"恢复条件"用同一把尺子（占用回到 vramLowRatio 以下），否则会这样：
 * 10 分钟到点恢复 → TTS 加载中显存还没顶上去 → 下一轮判定"不紧张"就解除武装 →
 * TTS 一加载完 90%，马上又被收回，恢复等于没恢复。
 */
export function canAutoRelease(state, options = {}) {
  const cfg = { ...RESOURCE_DEFAULTS, ...options }
  const { fullscreen = false, pressure = null, ratio = null } = state ?? {}
  if (fullscreen) return false
  if (pressure === true) return false
  if (ratio === null) return true
  return ratio <= cfg.vramLowRatio
}

/**
 * 已经让路之后，下一步该干什么（纯函数，便于验收）。
 *
 * 为什么不能"不紧张就恢复"：TTS worker 自己就要 1.5GB。显存 74% 时恢复，
 * 加载完立刻顶到 92%，20 秒后又被让路——1.5GB 反复装卸，比一直占着更糟。
 * 所以显存让路必须等占用真的回到低水位（vramLowRatio）才恢复。
 *
 * @param {{cause:'fullscreen'|'vram'|'manual'|'', fullscreen:boolean, pressure:boolean|null, ratio:number|null,
 *          suspendedAt:number, nowMs:number, busy:boolean}} state
 * @returns {{action:'resume'|'stay'|'switch-vram', timedOut:boolean}}
 */
export function nextVoiceAction(state, options = {}) {
  const cfg = { ...RESOURCE_DEFAULTS, ...options }
  const {
    cause = '', fullscreen = false, pressure = null, ratio = null,
    suspendedAt = 0, nowMs = Date.now(), busy = false,
  } = state ?? {}

  if (busy) return { action: 'stay', timedOut: false }
  const timedOut = cause !== 'fullscreen' && suspendedAt > 0 && nowMs - suspendedAt >= cfg.vramReleaseMaxMs
  if (timedOut) return { action: 'resume', timedOut: true }
  // 手动释放只认"到点恢复"或用户自己取消，不跟着显存回落自动恢复
  if (cause === 'manual') return { action: 'stay', timedOut: false }
  if (cause === 'fullscreen') {
    if (fullscreen) return { action: 'stay', timedOut: false }
    // 退出全屏但显存还紧：先别预热，转成"显存让路"，等回落或 10 分钟到点
    return { action: pressure === true ? 'switch-vram' : 'resume', timedOut: false }
  }
  if (pressure !== false) return { action: 'stay', timedOut: false }
  if (ratio === null) return { action: 'resume', timedOut: false }
  return { action: ratio <= cfg.vramLowRatio ? 'resume' : 'stay', timedOut: false }
}

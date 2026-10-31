/**
 * 音乐播放：走 LX Music（lx-music-desktop）的开放 API + Scheme URL。
 *
 * 为什么换成 LX：
 *   之前那套（ncm-cli + 自己签名直连 + mpv）里，CLI 的播放守护进程不稳、
 *   签名直连要自己管 token（24 小时就过期，还得扫码），mpv 又要单独装。
 *   LX Music 自带播放内核和音源，对外只暴露两样东西：
 *     1. 本地 HTTP 开放 API（默认 http://127.0.0.1:23330）——查状态、控制播放；
 *     2. Scheme URL（lxmusic://…）——搜索并播放、切歌、收藏等。
 *   我们只当"遥控器"，不再自己取流、不再自己管 token。
 *
 * 文档：https://lxmusic.toside.cn/desktop/open-api 、 /desktop/scheme-url
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.CUA_VA_LX_BASE ?? 'http://127.0.0.1:23330'
const TIMEOUT_MS = 2500
/** 轮询里单次看状态用的超时：只是瞥一眼，别让一次慢请求把整个等待窗吃掉 */
const POLL_TIMEOUT_MS = 800

/** LX 的状态值：playing / paused / error / stoped（注意官方拼写就是 stoped） */
const STOPPED = new Set(['stoped', 'error'])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function get(pathAndQuery, timeoutMs = TIMEOUT_MS) {
  const response = await fetch(`${BASE}${pathAndQuery}`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`LX API ${response.status}`)
  return response.text()
}

/** LX 在不在跑（启动时探一次，决定要不要提示用户先开 LX） */
export async function lxAvailable() {
  return (await statusOrNull()) !== null
}

/**
 * 播放器状态。
 * 字段名对齐我们自己的面板，免得再各处做映射。
 */
export async function lxStatus(timeoutMs = TIMEOUT_MS) {
  const raw = await get('/status?filter=status,name,singer,albumName,duration,progress,volume,mute,lyricLineText,picUrl', timeoutMs)
  const data = JSON.parse(raw)
  const status = String(data.status ?? 'stoped')
  return {
    ok: true,
    status: STOPPED.has(status) ? 'stopped' : status,
    rawStatus: status,
    title: String(data.name ?? ''),
    artist: String(data.singer ?? ''),
    album: String(data.albumName ?? ''),
    duration: Number(data.duration) || 0,
    position: Number(data.progress) || 0,
    volume: data.volume === undefined ? null : Number(data.volume),
    mute: data.mute === true,
    lyric: String(data.lyricLineText ?? ''),
    cover: typeof data.picUrl === 'string' ? data.picUrl : '',
  }
}

/**
 * 一次请求同时回答"LX 在不在"和"现在放到哪了"。
 * 以前是先 lxAvailable 再 lxStatus，两次往返；点歌总预算就 4 秒，能省就省。
 */
async function statusOrNull(timeoutMs = TIMEOUT_MS) {
  try {
    return await lxStatus(timeoutMs)
  } catch {
    return null
  }
}

/** 控制类接口（GET，无参数或 query 参数） */
const CONTROL_PATH = {
  play: '/play',
  pause: '/pause',
  next: '/skip-next',
  prev: '/skip-prev',
  collect: '/collect',
  uncollect: '/uncollect',
}

/**
 * 打开 scheme URL。
 * 用系统协议处理器（cmd start）而不是 Electron 的 shell，工具层不依赖 electron，
 * 这样自检脚本也能直接跑。
 */
/*
 * scheme 的打开方式可注入：
 *   - 应用里跑 → 主进程注入 electron 的 shell.openExternal（等同浏览器点链接，最可靠）
 *   - 命令行自检 → 退回系统 ShellExecute（cmd start）
 * 直接在命令行里用 cmd start 证明不了应用里也会失败——两者走的 ShellExecute 上下文不同。
 */
let schemeOpener = null

/** 主进程注入：用 electron 的 shell.openExternal 打开 scheme */
export function setSchemeOpener(opener) {
  schemeOpener = opener
}

function openScheme(url) {
  if (typeof schemeOpener === 'function') {
    try {
      const result = schemeOpener(url)
      return Promise.resolve(result !== false)
    } catch {
      return Promise.resolve(false)
    }
  }
  return new Promise((resolve) => {
    try {
      const child = spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' })
      child.on('error', () => resolve(false))
      child.on('spawn', () => { child.unref(); resolve(true) })
    } catch {
      resolve(false)
    }
  })
}

/** scheme URL 里参数要单独编码，否则带 / 或空格会被截断 */
export function schemeUrl(path, params = {}) {
  if (Object.keys(params).length === 0) return `lxmusic://${path}`
  const data = encodeURIComponent(JSON.stringify(params))
  return `lxmusic://${path}?data=${data}`
}

/**
 * 点歌用的 scheme URL。
 *
 * 必须走 data 形式（?data={json}）而不是路径形式（music/searchPlay/晴天-周杰伦）：
 * LX 解路径时按第一个 "-" 硬切 name-singer，歌名自带连字符（「稻香-Live」）就会被拆错；
 * 而且路径形式只认「歌名-歌手」两段，albumName / interval 这些参数根本没处放。
 */
export function searchPlayUrl(name, singer = '') {
  const params = { name }
  if (singer !== '') params.singer = singer
  return schemeUrl('music/searchPlay', params)
}

/** 歌名 + 歌手拼成一句给人看的话 */
function describeSong(name, singer) {
  const songName = String(name ?? '')
  const songSinger = String(singer ?? '')
  return songSinger === '' ? songName : `${songName} - ${songSinger}`
}

/**
 * 歌手是不是同一个人（只判"对不对得上"，不排高低）。
 *
 * 音源返回的歌手写法五花八门：「周杰伦」「周杰伦 Jay Chou」「Jay Chou」。
 * 去掉标点空白、转小写后，只要一方包含另一方就算匹配；任一侧为空就当没法判断，不报警。
 * 导出给验收脚本用。
 */
export function singerMatches(requested, actual) {
  const clean = (text) => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const want = clean(requested)
  const got = clean(actual)
  if (want === '' || got === '') return true
  return want.includes(got) || got.includes(want)
}

/**
 * 从工具参数里取歌名/歌手。
 *
 * 以前只有一个 keyword，靠空格切「歌名 歌手」：模型填「周杰伦的晴天」时切出来
 * name=周杰伦的晴天、singer 为空，整串拿去模糊搜，最先命中的往往是翻唱。
 * 现在模型分 name / singer 两个字段填；keyword 只作为旧格式（面板、脚本）的兜底。
 * 导出给验收脚本用。
 */
export function parseSongArgs(args = {}) {
  let name = String(args.name ?? '').trim()
  let singer = String(args.singer ?? '').trim()
  const keyword = String(args.keyword ?? '').trim()
  if (name === '' && keyword !== '') {
    const [head, ...rest] = keyword.split(/\s+/u)
    name = head
    singer = rest.join(' ')
  }
  return { name, singer }
}

/**
 * 按歌名 + 歌手搜索并播放。
 * 走 music/searchPlay：LX 会自己挑音源、自己取流、自己播。
 *
 * 几个坑都在这儿处理（都是实测出来的）：
 *   1. LX 没开时先等它的开放 API 就绪，否则 scheme 会被启动过程吃掉（日志里那次 8 秒超时）；
 *   2. 成功判定不能用"在播放"——上一首还在放的时候它立刻成立，会拿旧歌名当成功；
 *      改成"歌名变了"或"从暂停变成播放"；
 *   3. 超时从 8 秒收到 4 秒：歌名对的时候 1~2 秒就换好了，等更久基本是搜不到；
 *   4. 轮询里单次查询只等 800ms：总窗 4 秒是给 LX 内部搜索的，不该被一次卡住的请求吃掉。
 */
export async function playSong(name, singer = '') {
  const songName = String(name ?? '').trim()
  if (songName === '') throw new Error('要播放什么？给我个歌名')
  const songSinger = String(singer ?? '').trim()
  const requested = describeSong(songName, songSinger)

  // ① 一次 /status：既判断 LX 在不在，又当"放之前"的基线（以前查两次，白花一个往返）
  let before = await statusOrNull()
  if (before === null) {
    if (!launchLx()) {
      throw new Error('LX Music 没在运行，也没找到它的安装路径；先手动打开 LX')
    }
    const readyDeadline = Date.now() + 6000
    while (Date.now() < readyDeadline) {
      await sleep(400)
      before = await statusOrNull()
      if (before !== null) break
    }
    if (before === null) throw new Error('LX 起来了，但开放 API 还没就绪（去 LX 设置里确认已启用开放 API）')
  }

  // ② 发 data 形式的 scheme：不留连字符拆分的机会，歌手单独作为一个字段
  const opened = await openScheme(searchPlayUrl(songName, songSinger))
  if (!opened) throw new Error('没能唤起 LX Music（确认它已安装并在运行）')

  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    await sleep(350)
    const state = await statusOrNull(POLL_TIMEOUT_MS)
    if (state === null) continue
    const titleChanged = state.title !== '' && state.title !== before.title
    const resumed = before.status !== 'playing' && state.status === 'playing' && state.title !== ''
    if (titleChanged || resumed) return { ...state, matched: true, requested }
  }

  // ③ 超时：如实返回当前状态，别假装成功
  const after = await statusOrNull()
  if (after === null) throw new Error('LX 没响应，点开 LX 看看是不是卡住了')
  return { ...after, matched: false, requested }
}

/** 按 LX 可执行文件路径启动（用户没开 LX 时尝试拉起） */
export function launchLx() {
  const candidates = [
    process.env.LX_MUSIC_EXE,
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'lx-music-desktop', 'lx-music-desktop.exe'),
    'C:\\Program Files\\lx-music-desktop\\lx-music-desktop.exe',
    join(process.env.LOCALAPPDATA ?? '', 'lx-music-desktop', 'lx-music-desktop.exe'),
  ].filter((item) => typeof item === 'string' && item !== '')
  const exe = candidates.find((path) => existsSync(path))
  if (exe === undefined) return false
  try {
    const child = spawn(exe, [], { windowsHide: false, detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * 工具定义：给模型看的。
 *
 * 必须是 { type:'function', function:{ name, description, parameters } } 的嵌套格式，
 * 和其他工具（shell/files/…）保持一致——写成平铺的会被模型 API 422 拒收
 * （实测报 "tools[19]: missing field `function`"）。
 */
export const LX_MUSIC_TOOL = {
  type: 'function',
  function: {
    name: 'music',
    description: [
      '控制 LX Music 播放音乐。用户说"放首歌/听xxx/暂停/下一首/声音小点/唱到哪了"都用它。',
      'play 给 name（歌名）和 singer（歌手，可选），会搜索并直接播放。',
      '歌名和歌手必须分开填：用户说「放周杰伦的晴天」，name="晴天"、singer="周杰伦"。',
      '别把歌手写进 name，也别自己加「原唱/完整版」之类的后缀——多一个字就可能搜到翻唱或者搜不到。',
      'state 返回当前歌曲、进度、音量；lyric 返回当前歌词行。',
      'LX 没有"停止"，close/stop 用 pause 代替。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['play', 'pause', 'resume', 'toggle', 'next', 'prev', 'seek', 'volume', 'state', 'lyric', 'collect'],
          description: '动作',
        },
        name: { type: 'string', description: 'play 时必填：歌名，只写歌名，如「晴天」' },
        singer: { type: 'string', description: 'play 时可选：歌手，如「周杰伦」；用户说了歌手就一定要填，能少搜到翻唱' },
        seconds: { type: 'number', description: 'seek 时必填：跳到第几秒' },
        level: { type: 'number', description: 'volume 时必填：0-100' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
}

/**
 * 工具入口：返回 { text, data }。
 * text 是给模型/用户看的一句话，data 是结构化结果（面板也用）。
 */
export async function runLx(args = {}) {
  const action = String(args.action ?? '')
  try {
    if (action === 'play' || action === 'resume') {
      /*
       * 语义区分：
       *   play 带 name  → 搜索并播放（scheme 的 music/searchPlay）
       *   play 不带 name / resume → 继续播放（开放 API 的 GET /play）
       * 之前 resume 没实现，"恢复播放"会报"要播放什么？给我个歌名"。
       */
      const { name, singer } = parseSongArgs(args)
      if (action === 'resume' || name === '') {
        await get('/play')
        const status = await lxStatus()
        return { text: '继续放', data: { ok: true, ...status } }
      }
      const status = await playSong(name, singer)
      const title = describeSong(status.title, status.artist)
      if (status.matched === true) {
        /*
         * 播放成功 ≠ 放对了版本。LX 只按关键词取第一条，翻唱/伴奏常年排在原唱前面
         * （2.x 没有内置音源，排序完全由用户导入的音源脚本决定）。
         * 歌手对不上就如实说，别让用户以为放的是原唱——ok=false 也会让这轮开出追问窗口。
         */
        if (!singerMatches(singer, status.artist)) {
          return {
            text: `放上了，但这是「${status.artist}」的版本，不是「${singer}」。要换的话再说一声"换成 ${singer} 的那版"。`,
            // status.ok 是 lxStatus 的"读到状态了"，这里要的是"这单成没成"，所以放在最后覆盖
            data: { ...status, artistMatched: false, ok: false },
          }
        }
        return { text: `正在放：${title}`, data: { ...status, artistMatched: true, ok: true } }
      }
      /*
       * 没换歌 = LX 大概率没搜到。
       * 这时候别报"放上了"——用户会以为在放，实际还是上一首。
       * 如实说，并把"能怎么重试"的线索给模型。
       */
      const hint = singer === '' ? '换个歌名、或把歌手也说清楚再试。' : '换个歌名，或者去掉歌手再试。'
      return {
        text: `没搜到「${status.requested}」：LX 里现在还是「${title === '' ? '没在放' : title}」。${hint}`,
        // 同上：status.ok 表示状态读到了，不是搜到了
        data: { ...status, ok: false },
      }
    }
    if (action === 'toggle') {
      // 用 scheme：LX 官方就有"切换播放/暂停"
      await openScheme('lxmusic://player/togglePlay')
      await new Promise((resolve) => setTimeout(resolve, 400))
      const status = await lxStatus()
      return { text: status.status === 'playing' ? '继续放了' : '暂停了', data: { ok: true, ...status } }
    }
    if (action === 'seek') {
      const seconds = Math.max(0, Number(args.seconds) || 0)
      await get(`/seek?offset=${Math.round(seconds)}`)
      return { text: `跳到 ${Math.round(seconds)} 秒`, data: { ok: true } }
    }
    if (action === 'volume') {
      const level = Math.min(100, Math.max(0, Number(args.level) || 0))
      await get(`/volume?volume=${Math.round(level)}`)
      return { text: `音量 ${Math.round(level)}`, data: { ok: true } }
    }
    if (action === 'collect') {
      await get('/collect')
      return { text: '收藏了', data: { ok: true } }
    }
    if (CONTROL_PATH[action] !== undefined) {
      await get(CONTROL_PATH[action])
      const label = { play: '继续放', pause: '暂停了', next: '下一首', prev: '上一首' }[action] ?? action
      return { text: label, data: { ok: true } }
    }
    if (action === 'state' || action === 'lyric') {
      const status = await lxStatus()
      if (action === 'lyric') {
        return {
          text: status.lyric === '' ? '这会儿没有歌词' : status.lyric,
          data: { ok: true, ...status },
        }
      }
      if (status.status === 'stopped') return { text: '现在没在放歌', data: { ok: true, ...status } }
      const progress = `${Math.round(status.position)}s/${Math.round(status.duration)}s`
      return {
        text: `${status.status === 'playing' ? '在放' : '暂停中'}「${status.title}${status.artist === '' ? '' : ` - ${status.artist}`}」${progress}`,
        data: { ok: true, ...status },
      }
    }
    return { text: `不认识的音乐动作：${action}`, data: { ok: false, error: 'unknown action' } }
  } catch (error) {
    const hint = /fetch|ECONNREFUSED|timeout|LX API/iu.test(error.message)
      ? '（LX Music 好像没开，或者没开「开放 API 服务」）'
      : ''
    return { text: `音乐操作失败：${error.message}${hint}`, data: { ok: false, error: error.message } }
  }
}

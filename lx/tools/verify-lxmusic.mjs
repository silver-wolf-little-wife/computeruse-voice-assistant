/**
 * LX 音乐链路验收。
 *
 * 分两层：
 *   1. 纯逻辑：scheme URL 拼装、点歌参数解析、歌手比对（不依赖 LX）
 *   2. 真机：LX 在跑时验 /status、/pause、/play、点歌
 *
 * 用法：node tools/verify-lxmusic.mjs
 */
import { schemeUrl, searchPlayUrl, parseSongArgs, singerMatches, lxAvailable, lxStatus, runLx } from '../packages/tools/lxmusic.mjs'

const cases = []
function check(name, pass, detail = '') {
  cases.push({ name, pass, detail })
}

// ---- 1) scheme 拼装
check('无参数 scheme', schemeUrl('player/skipNext') === 'lxmusic://player/skipNext', schemeUrl('player/skipNext'))
const withData = schemeUrl('music/searchPlay', { name: '晴天', singer: '周杰伦' })
check('data scheme 前缀', withData.startsWith('lxmusic://music/searchPlay?data='), withData.slice(0, 60))
check('data 可还原', JSON.parse(decodeURIComponent(withData.split('data=')[1])).name === '晴天', '')

// ---- 1.1) 点歌参数：歌名/歌手分开，不再靠空格猜
const playUrl = searchPlayUrl('晴天', '周杰伦')
const payload = JSON.parse(decodeURIComponent(playUrl.split('data=')[1]))
check('点歌走 data 形式', playUrl.startsWith('lxmusic://music/searchPlay?data='), playUrl.slice(0, 56))
check('歌手独立成字段', payload.name === '晴天' && payload.singer === '周杰伦', JSON.stringify(payload))
const nameOnly = JSON.parse(decodeURIComponent(searchPlayUrl('晴天').split('data=')[1]))
check('没歌手不塞空字段', Object.hasOwn(nameOnly, 'singer') === false, JSON.stringify(nameOnly))
check('歌名带连字符不拆', JSON.parse(decodeURIComponent(searchPlayUrl('稻香-Live').split('data=')[1])).name === '稻香-Live', '')

const split = parseSongArgs({ name: '晴天', singer: '周杰伦' })
check('name/singer 原样传递', split.name === '晴天' && split.singer === '周杰伦', JSON.stringify(split))
const whole = parseSongArgs({ name: '周杰伦的晴天' })
check('整串歌名不被硬切', whole.name === '周杰伦的晴天' && whole.singer === '', JSON.stringify(whole))
const legacy = parseSongArgs({ keyword: '晴天 周杰伦' })
check('旧 keyword 兜底', legacy.name === '晴天' && legacy.singer === '周杰伦', JSON.stringify(legacy))

check('歌手一致', singerMatches('周杰伦', '周杰伦') === true, '')
check('歌手别名一致', singerMatches('周杰伦', '周杰伦 Jay Chou') === true, '')
check('翻唱能识别', singerMatches('周杰伦', '某翻唱歌手') === false, '')
check('歌手缺失不报警', singerMatches('周杰伦', '') === true, '')

// ---- 2) 真机
const available = await lxAvailable()
check('LX 开放 API 可达', available === true || available === false, String(available))
if (available) {
  const status = await lxStatus()
  check('/status 解析状态', ['playing', 'paused', 'stopped'].includes(status.status), status.rawStatus)
  check('/status 带歌名', typeof status.title === 'string', status.title)

  const before = status.status
  await runLx({ action: before === 'playing' ? 'pause' : 'play' })
  await new Promise((resolve) => setTimeout(resolve, 800))
  const after = await lxStatus()
  check('控制接口生效', after.status !== before, `${before} → ${after.status}`)
  // 恢复原状态，别把用户的歌停了
  await runLx({ action: before === 'playing' ? 'play' : 'pause' })
} else {
  console.log('（LX 没运行，只验了 scheme 拼装；要验真机请先开 LX 并启用开放 API）')
}

const failed = cases.filter((item) => item.pass !== true)
console.log('LX 音乐验收\n' + '='.repeat(56))
for (const item of cases) {
  console.log(`${item.pass ? '✓' : '✗'} ${item.name.padEnd(18, ' ')} ${item.detail ?? ''}`)
}
console.log('='.repeat(56))
console.log(JSON.stringify({ cases: cases.length, failed: failed.length, verdict: failed.length === 0 ? 'pass' : 'fail' }))
process.exitCode = failed.length === 0 ? 0 : 1

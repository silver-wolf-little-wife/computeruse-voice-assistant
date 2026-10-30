/**
 * 复现"第一次唤醒后就失效"：
 * 用一个 StreamingPipeline（里面含说话起点重置/静音重置）连续喂多轮
 *   10 秒静音 → 唤醒词 → 10 秒静音 → 唤醒词 …
 * 记录每一轮有没有命中。
 */
import { createRequire } from 'node:module'
import { StreamingPipeline } from '../packages/voice/stream.mjs'
import { readWav } from '../packages/voice/wav.mjs'

const require = createRequire(import.meta.url)
const { LinearResampler } = require('sherpa-onnx-node/resampler.js')

function resample(x, srIn, srOut) {
  if (srIn === srOut) return x
  const resampler = new LinearResampler(srIn, srOut)
  const parts = []
  for (let i = 0; i < x.length; i += 2205) {
    const piece = x.subarray(i, Math.min(i + 2205, x.length))
    parts.push(i + 2205 >= x.length ? resampler.flush(piece) : resampler.resample(piece))
  }
  const merged = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
  let cursor = 0
  for (const part of parts) { merged.set(part, cursor); cursor += part.length }
  return merged
}

const audio = readWav('assets/test/nihao-langbao.wav')
const phrase = resample(audio.samples, audio.sampleRate, 16000)

const pipeline = new StreamingPipeline()
const ROUNDS = 8
const results = []

function feed(samples) {
  for (let i = 0; i < samples.length; i += 1600) {
    const result = pipeline.push(samples.subarray(i, Math.min(i + 1600, samples.length)))
    if (result.wake !== null) return result.wake
  }
  return null
}

for (let round = 1; round <= ROUNDS; round += 1) {
  const silence = new Float32Array(16000 * 10) // 10 秒静音（会触发 3 秒静音重置）
  feed(silence)
  const hit = feed(phrase)
  results.push({ round, hit })
  console.log(`第 ${round} 轮: ${hit === null ? '✗ 未命中' : `✓ ${hit}`}`)
}

const missed = results.filter((item) => item.hit === null).length
console.log('='.repeat(50))
console.log(JSON.stringify({ rounds: ROUNDS, missed, pass: missed === 0 }))
process.exitCode = missed === 0 ? 0 : 1

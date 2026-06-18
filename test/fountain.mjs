// QRDrop v2 — LT fountain code 라운드트립 검증 (Node, 카메라/QR 광학 제외)
//
// 핵심 검증: 임의 손실·중복·순서뒤섞임 상황에서도 "받은 심볼 ≈ 블록 수 + 소량 오버헤드"만
// 모이면 원본 바이트가 무손실 복원되는가. v1의 tail 비효율(재시청)이 사라졌는지 측정한다.
//
// (src/fountain.ts 와 동일 알고리즘을 순수 JS로 인라인 — test/roundtrip.mjs 컨벤션과 동일,
//  빌드 의존 없이 node test/fountain.mjs 로 바로 검증)

// --- 코덱 (src/fountain.ts 미러) ---
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function degreeCDF(k, c = 0.05, delta = 0.5) {
  if (k <= 1) return [0, 1]
  const rho = new Array(k + 1).fill(0)
  rho[1] = 1 / k
  for (let d = 2; d <= k; d++) rho[d] = 1 / (d * (d - 1))
  const R = c * Math.log(k / delta) * Math.sqrt(k)
  const kR = Math.floor(k / R)
  const tau = new Array(k + 1).fill(0)
  for (let d = 1; d <= k; d++) {
    if (d < kR) tau[d] = R / (d * k)
    else if (d === kR) tau[d] = (R * Math.log(R / delta)) / k
  }
  let beta = 0
  for (let d = 1; d <= k; d++) beta += rho[d] + tau[d]
  const cdf = new Array(k + 1).fill(0)
  let acc = 0
  for (let d = 1; d <= k; d++) {
    acc += (rho[d] + tau[d]) / beta
    cdf[d] = acc
  }
  cdf[k] = 1
  return cdf
}

function sampleDegree(rng, cdf, k) {
  const x = rng()
  for (let d = 1; d <= k; d++) if (x <= cdf[d]) return d
  return k
}

function symbolBlocks(seed, k, cdf) {
  if (seed < k) return [seed]
  const rng = mulberry32(seed)
  const d = Math.min(sampleDegree(rng, cdf, k), k)
  const set = new Set()
  while (set.size < d) set.add(Math.floor(rng() * k))
  return [...set]
}

function xorInto(dst, src) {
  for (let i = 0; i < dst.length; i++) dst[i] ^= src[i]
}

function makeEncoder(bytes, blockSize) {
  const k = Math.max(1, Math.ceil(bytes.length / blockSize))
  const cdf = degreeCDF(k)
  const blocks = []
  for (let i = 0; i < k; i++) {
    const b = new Uint8Array(blockSize)
    b.set(bytes.subarray(i * blockSize, Math.min((i + 1) * blockSize, bytes.length)))
    blocks.push(b)
  }
  return {
    k,
    len: bytes.length,
    symbol(seed) {
      const out = new Uint8Array(blockSize)
      for (const i of symbolBlocks(seed, k, cdf)) xorInto(out, blocks[i])
      return out
    },
  }
}

function makeDecoder(k, len, blockSize) {
  const cdf = degreeCDF(k)
  const recovered = new Array(k).fill(null)
  const pending = []
  let recoveredCount = 0
  let symbolsSeen = 0
  function peel() {
    let progress = true
    while (progress) {
      progress = false
      for (let s = 0; s < pending.length; s++) {
        const sym = pending[s]
        if (sym.blocks.size !== 1) continue
        const idx = sym.blocks.values().next().value
        pending.splice(s, 1)
        if (recovered[idx]) {
          progress = true
          break
        }
        recovered[idx] = sym.data
        recoveredCount++
        for (const other of pending) {
          if (other.blocks.has(idx)) {
            other.blocks.delete(idx)
            xorInto(other.data, sym.data)
          }
        }
        progress = true
        break
      }
    }
  }
  return {
    get done() {
      return recoveredCount === k
    },
    get recoveredCount() {
      return recoveredCount
    },
    get symbolsSeen() {
      return symbolsSeen
    },
    addSymbol(seed, data) {
      symbolsSeen++
      if (recoveredCount === k) return
      const d = data.slice()
      const blocks = new Set()
      for (const i of symbolBlocks(seed, k, cdf)) {
        if (recovered[i]) xorInto(d, recovered[i])
        else blocks.add(i)
      }
      if (blocks.size === 0) return
      pending.push({ blocks, data: d })
      peel()
    },
    result() {
      if (recoveredCount !== k) return null
      const out = new Uint8Array(k * blockSize)
      for (let i = 0; i < k; i++) out.set(recovered[i], i * blockSize)
      return out.subarray(0, len)
    },
  }
}

// --- 테스트 하니스 ---
function randomBytes(n, seed) {
  const rng = mulberry32(seed)
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = Math.floor(rng() * 256)
  return b
}

function equal(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// loss 확률로 심볼을 떨어뜨리며 송신. done까지 걸린 심볼 수 / 오버헤드 측정.
function simulate(byteLen, blockSize, lossRate, seedBase) {
  const data = randomBytes(byteLen, seedBase)
  const enc = makeEncoder(data, blockSize)
  const dec = makeDecoder(enc.k, enc.len, blockSize)
  const lossRng = mulberry32(seedBase ^ 0x9e3779b9)
  let seed = 0
  const cap = enc.k * 20 + 1000 // 무한루프 방지 상한
  while (!dec.done && seed < cap) {
    const sym = enc.symbol(seed)
    if (lossRng() >= lossRate) dec.addSymbol(seed, sym) // 손실 아니면 수신
    seed++
  }
  const ok = dec.done && equal(dec.result(), data)
  const overhead = dec.done ? dec.symbolsSeen / enc.k : Infinity
  return { ok, k: enc.k, symbolsSeen: dec.symbolsSeen, overhead }
}

let pass = 0
let fail = 0
console.log('bytes | block |   k | loss | 수신심볼 | 오버헤드 | 결과')
console.log('------|-------|-----|------|----------|----------|-----')
for (const byteLen of [1500, 13000, 28000, 60000]) {
  for (const lossRate of [0, 0.2, 0.5]) {
    const blockSize = 525 // base64 ~700 chars 에 해당하는 바이트 블록
    const r = simulate(byteLen, blockSize, lossRate, byteLen + Math.round(lossRate * 1000))
    const status = r.ok ? 'OK ✅' : 'FAIL ❌'
    if (r.ok) pass++
    else fail++
    console.log(
      `${String(byteLen).padStart(5)} | ${String(blockSize).padStart(5)} | ${String(r.k).padStart(3)} | ` +
        `${String(Math.round(lossRate * 100) + '%').padStart(4)} | ${String(r.symbolsSeen).padStart(8)} | ` +
        `${(r.overhead).toFixed(2).padStart(8)} | ${status}`
    )
  }
}

console.log(`\n총 ${pass + fail}건 중 통과 ${pass} / 실패 ${fail}`)
console.log('오버헤드 = 수신 심볼 수 / 블록 수 (1.0에 가까울수록 이상적, fountain은 보통 1.05~1.30)')
process.exit(fail ? 1 : 0)

// QRDrop — 비밀번호 기반 암호화 검증 (Node WebCrypto)
//
// 1) 올바른 비밀번호: 암호화 → 복호화 라운드트립 무손실
// 2) 틀린 비밀번호: 복호화 거부(GCM 인증 실패)
// 3) 변조된 암호문: 복호화 거부
//
// (src/crypto.ts 와 동일 알고리즘: PBKDF2-SHA256 600k → AES-256-GCM)

import { webcrypto as crypto } from 'node:crypto'

const SALT_BYTES = 16
const IV_BYTES = 12
const PBKDF2_ITERS = 600_000

async function deriveKey(password, salt) {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function encryptBytes(password, plaintext) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveKey(password, salt)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext))
  const out = new Uint8Array(SALT_BYTES + IV_BYTES + ct.length)
  out.set(salt, 0)
  out.set(iv, SALT_BYTES)
  out.set(ct, SALT_BYTES + IV_BYTES)
  return out
}

async function decryptBytes(password, container) {
  if (container.length < SALT_BYTES + IV_BYTES + 16) throw new Error('too short')
  const salt = container.subarray(0, SALT_BYTES)
  const iv = container.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES)
  const ct = container.subarray(SALT_BYTES + IV_BYTES)
  const key = await deriveKey(password, salt)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct))
}

function equal(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
function randomBytes(n) {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

let pass = 0
let fail = 0
const check = (name, ok) => {
  console.log(`${ok ? 'OK ✅' : 'FAIL ❌'}  ${name}`)
  ok ? pass++ : fail++
}

const PW = 'correct horse battery staple'
const data = randomBytes(13000) // ~사진 한 장 분량

// 1) 라운드트립
const container = await encryptBytes(PW, data)
const back = await decryptBytes(PW, container)
check('올바른 비밀번호 라운드트립 무손실', equal(back, data))
check('컨테이너 = salt16+iv12+태그16+평문 길이', container.length === 16 + 12 + 16 + data.length)
check('암호문 ≠ 평문(앞부분)', !equal(container.subarray(28, 28 + 32), data.subarray(0, 32)))

// 2) 틀린 비밀번호
let rejectedWrongPw = false
try {
  await decryptBytes(PW + 'x', container)
} catch {
  rejectedWrongPw = true
}
check('틀린 비밀번호 거부', rejectedWrongPw)

// 3) 변조된 암호문
const tampered = container.slice()
tampered[tampered.length - 1] ^= 0xff // 마지막 바이트(태그) 뒤집기
let rejectedTamper = false
try {
  await decryptBytes(PW, tampered)
} catch {
  rejectedTamper = true
}
check('변조된 암호문 거부(무결성)', rejectedTamper)

console.log(`\n총 ${pass + fail}건 중 통과 ${pass} / 실패 ${fail}`)
console.log('→ PBKDF2-SHA256 600k + AES-256-GCM. 보안은 비밀번호 강도에 의존(긴 패스프레이즈 권장).')
process.exit(fail ? 1 : 0)

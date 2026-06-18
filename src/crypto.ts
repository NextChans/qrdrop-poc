// QRDrop — 공유 비밀번호 기반 종단간 암호화 (WebCrypto, 외부 의존 없음)
//
// 송신자와 수신자만 아는 비밀번호로 사진을 암호화한다. 화면을 누가 촬영해 "암호문"을
// 가져가도, 비밀번호를 모르면 열 수 없다. 보안은 전적으로 비밀번호 강도에 달려 있으므로
// 긴 패스프레이즈를 권장한다.
//
// 방식: PBKDF2-SHA256(60만 회)로 비밀번호+salt에서 AES-256 키를 유도하고, AES-256-GCM으로
// 암호화한다(기밀성 + 변조 감지). 컨테이너 = [salt(16) | iv(12) | ciphertext+tag].
// 이 컨테이너 바이트를 fountain으로 인코딩하므로 전송 파이프라인은 그대로다.
//
// 주의: WebCrypto SubtleCrypto는 보안 컨텍스트(HTTPS 또는 localhost)에서만 동작한다.
// Vercel(신뢰 HTTPS)·dev 자체서명 HTTPS에서 정상.

const SALT_BYTES = 16
const IV_BYTES = 12
const PBKDF2_ITERS = 600_000

// WebCrypto 타입(BufferSource)이 최신 lib의 Uint8Array<ArrayBufferLike>를 거부 → 캐스팅 헬퍼
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    bs(new TextEncoder().encode(password)),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: bs(salt), iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// plaintext → [salt | iv | ciphertext+tag]
export async function encryptBytes(password: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveKey(password, salt)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(iv) }, key, bs(plaintext)))
  const out = new Uint8Array(SALT_BYTES + IV_BYTES + ct.length)
  out.set(salt, 0)
  out.set(iv, SALT_BYTES)
  out.set(ct, SALT_BYTES + IV_BYTES)
  return out
}

// 컨테이너 → plaintext. 비밀번호가 틀리거나 데이터가 변조되면 GCM 인증 실패로 throw.
export async function decryptBytes(password: string, container: Uint8Array): Promise<Uint8Array> {
  if (container.length < SALT_BYTES + IV_BYTES + 16) throw new Error('암호문이 너무 짧습니다')
  const salt = container.subarray(0, SALT_BYTES)
  const iv = container.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES)
  const ct = container.subarray(SALT_BYTES + IV_BYTES)
  const key = await deriveKey(password, salt)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs(iv) }, key, bs(ct))
  return new Uint8Array(pt)
}

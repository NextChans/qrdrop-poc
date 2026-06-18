import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import basicSsl from '@vitejs/plugin-basic-ssl'

// MPA: index(landing) / send / receive
// 기본은 basicSsl 자체서명 HTTPS → 모바일 카메라(getUserMedia) 권한 요건 충족.
// QRDROP_HTTP=1 이면 평문 HTTP(자체검증/헤드리스 브라우저 등 인증서 없는 환경용).
const httpOnly = process.env.QRDROP_HTTP === '1'
export default defineConfig({
  plugins: httpOnly ? [] : [basicSsl()],
  server: {
    host: true, // 0.0.0.0 바인딩 → 같은 wifi의 폰에서 접근
    ...(httpOnly ? {} : { https: {} }),
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        send: resolve(__dirname, 'send.html'),
        receive: resolve(__dirname, 'receive.html'),
        selftest: resolve(__dirname, 'selftest.html'),
      },
    },
  },
})

import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'

// MPA: index(landing) / send / receive / selftest
// 기본은 basicSsl 자체서명 HTTPS → 모바일 카메라(getUserMedia) 권한 요건 충족.
// QRDROP_HTTP=1 이면 평문 HTTP(자체검증/헤드리스 브라우저 등 인증서 없는 환경용).
const httpOnly = process.env.QRDROP_HTTP === '1'

// PWA: 오프라인(인터넷 끊긴 환경이 본 앱의 핵심 시나리오)에서 설치형으로 동작.
// QRDrop은 전송 자체에 네트워크가 불필요하므로, 자산을 모두 precache 해두면 비행기/오프그리드에서
// 앱을 열어 바로 사용할 수 있다. registerType 'autoUpdate' 로 새 버전 자동 반영.
const pwa = VitePWA({
  registerType: 'autoUpdate',
  injectRegister: 'script-defer', // 각 HTML(모듈 없는 index 포함)에 SW 등록 스크립트 주입
  includeAssets: ['icon-192.png', 'icon-512.png', 'maskable-512.png', 'apple-touch-icon-180.png'],
  workbox: {
    globPatterns: ['**/*.{html,js,css,png,svg,webmanifest}'],
    navigateFallback: null, // MPA — 단일 SPA 폴백 사용 안 함
    cleanupOutdatedCaches: true,
    skipWaiting: true, // 새 SW 즉시 활성화 → 프로토콜 변경 시 옛 코드가 남지 않도록
    clientsClaim: true,
  },
  manifest: {
    name: 'QRDrop — 화면↔카메라 사진 전송',
    short_name: 'QRDrop',
    description: '인터넷 없이 화면과 카메라만으로 사진을 전송한다.',
    lang: 'ko',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#333d66',
    theme_color: '#5567ff',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
})

// 빌드 식별자 — 두 폰이 같은 버전(특히 프로토콜)인지 화면에서 즉시 확인하기 위함.
const buildId = new Date().toISOString().slice(0, 16).replace('T', ' ')

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: httpOnly ? [pwa] : [basicSsl(), pwa],
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

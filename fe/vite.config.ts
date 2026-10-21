import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// One id per build, compiled into the JS AND written to /version.json. The app
// compares the two (lib/freshness.ts) and reloads when the server has moved on:
// an iPhone kept running a build from before a fix for half an hour, because
// Safari never re-requested the page.
const BUILD_ID = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + Math.random().toString(36).slice(2, 6)

const versionFile = (): Plugin => ({
  name: 'itledger-version-file',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) + '\n' })
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), versionFile()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
})

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const backend = `http://localhost:${process.env.PORT || 3000}`

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': { target: backend, ws: true },
    },
  },
})

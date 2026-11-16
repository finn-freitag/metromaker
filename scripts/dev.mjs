// Runs the backend and the Vite dev server together: npm run dev
import { spawn } from 'node:child_process'

const children = [
  spawn('node', ['--watch', 'server/index.js'], { stdio: 'inherit' }),
  spawn('npx', ['vite'], { stdio: 'inherit' }),
]
const stop = () => children.forEach(child => child.kill())
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
children.forEach(child => child.on('exit', stop))

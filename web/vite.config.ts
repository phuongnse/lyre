import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Relative URLs, so the build works from GitHub Pages' /lyre/ path and from vite preview.
  base: './',
  plugins: [react()],
  test: { environment: 'jsdom' },
})

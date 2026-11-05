import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: '界面',
  plugins: [react()],
  build: { outDir: '../dist/界面', emptyOutDir: true },
});

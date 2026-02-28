import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const monacoEditorApi = fileURLToPath(
  new URL('./node_modules/monaco-editor/esm/vs/editor/editor.api.js', import.meta.url),
);

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  resolve: {
    alias: [
      // y-monaco@0.1.6 predates monaco-editor's `exports` map and still imports.
      { find: /^monaco-editor\/esm\/vs\/editor\/editor\.api\.js$/, replacement: monacoEditorApi },
    ],
  },
  build: {
    // Chunking is left to Rolldown's defaults, deliberately.
    chunkSizeWarningLimit: 2000,
  },
});

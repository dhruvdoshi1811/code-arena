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
      // y-monaco@0.1.6 predates monaco-editor's `exports` map and still imports
      // `monaco-editor/esm/vs/editor/editor.api.js`, which the map now rewrites into a
      // path that does not exist. Pointing it at the real file keeps y-monaco and the
      // app on ONE Monaco instance — `esm/vs/index.js` re-exports this same module, so
      // Range and Selection stay identity-comparable across the binding.
      { find: /^monaco-editor\/esm\/vs\/editor\/editor\.api\.js$/, replacement: monacoEditorApi },
    ],
  },
  build: {
    // Monaco is a large dependency and this app imports the full barrel, which drags in
    // every bundled language grammar. Trimming it to just python and javascript means
    // importing `editor.api` plus individual contributions by hand and is a real
    // optimisation to make later — not something to half-do now and misreport.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Keyed on module path, not on package entry. The object form attributes a
        // module to whichever listed package reached it first, so Monaco's core landed
        // in the collab chunk simply because y-monaco imported it — one Monaco instance
        // still, but a split that lied about what was in it.
        manualChunks(id: string) {
          if (id.includes('node_modules/monaco-editor')) return 'monaco';
          if (/node_modules[/\\](yjs|y-websocket|y-monaco|y-protocols|lib0)[/\\]/.test(id)) {
            return 'collab';
          }
          return undefined;
        },
      },
    },
  },
});

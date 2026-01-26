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
    // Chunking is left to Rolldown's defaults, deliberately.
    //
    // Under Vite 7/Rollup a hand-written `manualChunks` produced a clean monaco/collab
    // split. Under Vite 8/Rolldown the same function yields chunks whose contents do not
    // match their names, and the grouping semantics differ enough that a split we cannot
    // verify is worse than no split — a bundle labelled "collab" holding Monaco misleads
    // whoever reads it next. Rolldown's own splitting is competent; take it.
    //
    // The real win here is not chunking at all: this app imports the full monaco-editor
    // barrel, which drags in every bundled language grammar. Narrowing it to `editor.api`
    // plus the python and javascript contributions is the optimisation worth doing, and
    // it belongs with the language work in Phase D rather than here.
    chunkSizeWarningLimit: 2000,
  },
});

import * as monaco from 'monaco-editor';
// monaco-editor 0.5x ships an `exports` map (`"./*.js" -> "./esm/vs/*.js"`), so the
// long-standing `monaco-editor/esm/vs/...` specifier no longer resolves — it would
// expand to `esm/vs/esm/vs/...`. These are the paths the exports map actually exposes.
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';

/**
 * Monaco is self-hosted, not loaded from a CDN.
 *
 * `@monaco-editor/react` exists mainly to fetch Monaco from jsDelivr at runtime, which
 * we do not want: it adds a third-party origin to the critical path, and `y-monaco`
 * needs the raw editor instance anyway. Bundling it means these workers have to be
 * wired up by hand — without them Monaco silently falls back to running tokenization
 * on the main thread and the editor janks under load.
 */
window.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    // Python is a basic-languages grammar with no dedicated worker of its own.
    return new editorWorker();
  },
};

export { monaco };

import * as monaco from 'monaco-editor';
// monaco-editor 0.5x ships an `exports` map (`"./*.js" -> "./esm/vs/*.js"`).
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';

/** Monaco is self-hosted, not loaded from a CDN. */
window.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    // Python is a basic-languages grammar with no dedicated worker of its own.
    return new editorWorker();
  },
};

export { monaco };

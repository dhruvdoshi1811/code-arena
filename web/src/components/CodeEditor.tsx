import { useEffect, useRef, useState } from 'react';
import { MonacoBinding } from 'y-monaco';
import { monaco } from '../monacoSetup';
import type { Collab } from '../collab';
import type { Language } from '../api';

interface RemoteUser {
  clientId: number;
  name: string;
  color: string;
}

/** y-monaco tags remote selections with per-client CSS classes but does not style them. */
function useRemoteCursorStyles(collab: Collab): void {
  const [remotes, setRemotes] = useState<RemoteUser[]>([]);

  useEffect(() => {
    const { awareness } = collab.provider;

    const sync = () => {
      const next: RemoteUser[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;
        const user = (state as { user?: { name?: string; color?: string } }).user;
        if (user?.name && user.color) next.push({ clientId, name: user.name, color: user.color });
      });
      setRemotes(next);
    };

    sync();
    awareness.on('change', sync);
    return () => awareness.off('change', sync);
  }, [collab]);

  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = remotes
      .map(
        ({ clientId, name, color }) => `
.yRemoteSelection-${clientId} { background-color: ${color}44; }
.yRemoteSelectionHead-${clientId} {
  position: absolute;
  border-left: 2px solid ${color};
  border-top: 2px solid ${color};
  border-bottom: 2px solid ${color};
  height: 100%;
  box-sizing: border-box;
}
.yRemoteSelectionHead-${clientId}::after {
  content: '${name.replace(/'/g, "\\'")}';
  position: absolute;
  top: -1.4em;
  left: -2px;
  padding: 1px 4px;
  font-size: 11px;
  line-height: normal;
  white-space: nowrap;
  color: #0b1120;
  background-color: ${color};
  border-radius: 3px 3px 3px 0;
}`,
      )
      .join('\n');

    document.head.appendChild(style);
    return () => style.remove();
  }, [remotes]);
}

export function CodeEditor({ collab, language }: { collab: Collab; language: Language }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useRemoteCursorStyles(collab);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const editor = monaco.editor.create(host, {
      // Empty on purpose — MonacoBinding populates the model from the Y.Text.
      value: '',
      language,
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 14,
      scrollBeyondLastLine: false,
      padding: { top: 12 },
    });

    const model = editor.getModel();
    if (!model) return;

    const binding = new MonacoBinding(collab.text, model, new Set([editor]), collab.provider.awareness);

    return () => {
      binding.destroy();
      editor.dispose();
      model.dispose();
    };
  }, [collab, language]);

  return <div className="editor" ref={hostRef} />;
}

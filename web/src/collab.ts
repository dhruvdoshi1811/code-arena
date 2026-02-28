import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { gatewayWsUrl, type PublicUser } from './api';
import { colorForUser } from './auth';

/** Must match `CODE_TEXT_KEY` in the gateway's `src/realtime/ydoc.ts`. */
const CODE_TEXT_KEY = 'code';

export interface Collab {
  doc: Y.Doc;
  text: Y.Text;
  provider: WebsocketProvider;
  destroy(): void;
}

/** Open the CRDT document for a session. */
export function createCollab(sessionId: string, token: string, user: PublicUser): Collab {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`${gatewayWsUrl}/yjs`, sessionId, doc, {
    params: { token },
  });

  // Awareness is the cursor channel.
  provider.awareness.setLocalStateField('user', {
    name: user.displayName,
    color: colorForUser(user.id),
  });

  return {
    doc,
    provider,
    text: doc.getText(CODE_TEXT_KEY),
    destroy() {
      // Retracts this client's awareness state before closing.
      provider.awareness.setLocalState(null);
      provider.destroy();
      doc.destroy();
    },
  };
}

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { gatewayWsUrl, type PublicUser } from './api';
import { colorForUser } from './auth';

/** Must match `CODE_TEXT_KEY` in the gateway's `src/realtime/ydoc.ts`. A mismatch here
 *  is silent: everyone connects successfully and edits a document nobody else sees. */
const CODE_TEXT_KEY = 'code';

export interface Collab {
  doc: Y.Doc;
  text: Y.Text;
  provider: WebsocketProvider;
  destroy(): void;
}

/**
 * Open the CRDT document for a session.
 *
 * The provider appends the room name to the base URL, which is exactly the
 * `/yjs/<sessionId>` shape the gateway's upgrade router expects — chosen in Phase A so
 * no custom URL building is needed here. The token rides as a query parameter because a
 * browser cannot set an Authorization header on a WebSocket handshake.
 */
export function createCollab(sessionId: string, token: string, user: PublicUser): Collab {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`${gatewayWsUrl}/yjs`, sessionId, doc, {
    params: { token },
  });

  // Awareness is the cursor channel. y-monaco reads these states directly to render
  // remote selections, so publishing a name and colour here is all the UI has to do.
  provider.awareness.setLocalStateField('user', {
    name: user.displayName,
    color: colorForUser(user.id),
  });

  return {
    doc,
    provider,
    text: doc.getText(CODE_TEXT_KEY),
    destroy() {
      // Retracts this client's awareness state before closing, so the other tab's
      // cursor list drops it immediately rather than waiting for the 30s timeout.
      provider.awareness.setLocalState(null);
      provider.destroy();
      doc.destroy();
    },
  };
}

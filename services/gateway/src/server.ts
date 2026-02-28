import http from 'node:http';
import type { Express } from 'express';
import { createApp } from './app.js';
import { attachExecutionRelay } from './realtime/execution.js';
import { attachSocketIo, type AppIoServer } from './realtime/socket.js';
import { attachYjsWebSocket, type YjsTransport } from './realtime/yjs.js';

export interface Gateway {
  app: Express;
  httpServer: http.Server;
  io: AppIoServer;
  yjs: YjsTransport;
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

/** Composition root. */
export function createGateway(): Gateway {
  const app = createApp();
  const httpServer = http.createServer(app);
  const io = attachSocketIo(httpServer);
  const yjs = attachYjsWebSocket(httpServer);

  // Subscribes this instance to execution events from the orchestrator.
  void attachExecutionRelay(io).catch((err: unknown) => {
    console.error('[gateway] execution relay unavailable', err);
  });

  return {
    app,
    httpServer,
    io,
    yjs,
    listen: (port) =>
      new Promise<number>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, () => {
          const address = httpServer.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      }),
    // Tears down the network surface only.
    close: async () => {
      await yjs.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

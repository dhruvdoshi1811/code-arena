import { config } from './config.js';
import { closePool, pingDatabase } from './db/pool.js';
import { createGateway } from './server.js';
import { SOCKET_IO_PATH } from './realtime/socket.js';
import { YJS_PATH_PREFIX } from './realtime/yjs.js';
import { closeRedis, connectRedis, instanceId } from './realtime/redis.js';
import { connectKafka, disconnectKafka } from './kafka/producer.js';

async function main(): Promise<void> {
  // Fail loudly at boot rather than on the first request. Redis must be reachable
  // before the gateway is built, because the Socket.io adapter subscribes on creation.
  await pingDatabase();
  await connectRedis();
  await connectKafka();

  const gateway = createGateway();
  const port = await gateway.listen(config.port);

  console.log(`[gateway] listening on http://localhost:${port} (${config.nodeEnv})`);
  console.log(`[gateway]   instance  ${instanceId}`);
  console.log(`[gateway]   REST      http://localhost:${port}/api`);
  console.log(`[gateway]   socket.io ws://localhost:${port}${SOCKET_IO_PATH}`);
  console.log(`[gateway]   yjs       ws://localhost:${port}${YJS_PATH_PREFIX}<sessionId>?token=...`);

  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[gateway] ${signal} received, shutting down`);
      gateway
        .close()
        .then(() => Promise.all([closePool(), closeRedis(), disconnectKafka()]))
        .then(
          () => process.exit(0),
          (err: unknown) => {
            console.error('[gateway] error during shutdown', err);
            process.exit(1);
          },
        );
    });
  }
}

main().catch((err: unknown) => {
  console.error('[gateway] failed to start', err);
  process.exit(1);
});

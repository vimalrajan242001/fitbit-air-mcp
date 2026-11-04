import type { Server } from 'node:http';

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { HTTP_PORT, LOOPBACK_HOST } from './constants.js';
import { errorMessage } from './errors.js';
import { createMcpHttpServer } from './http.js';
import { log } from './log.js';
import { login } from './oauth.js';
import { createFitbitServer } from './server.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'login') {
    const result = await login();
    log(result.message);
    return;
  }
  if (command) {
    log('Usage: node dist/index.js [login]');
    process.exitCode = 1;
    return;
  }

  const httpServer = createMcpHttpServer(() => createFitbitServer());
  const listening = await listenOnLoopback(httpServer);
  if (listening) log(`fitbit-air-mcp listening on stdio and http://${LOOPBACK_HOST}:${HTTP_PORT}/mcp`);
  const stdio = serveStdio(() => createFitbitServer());
  const shutdown = async (): Promise<void> => {
    if (listening) httpServer.close();
    await stdio.close();
  };
  const shutdownAndExit = () => void shutdown().finally(() => process.exit(0));
  process.stdin.on('end', () => void shutdown());
  process.on('SIGINT', shutdownAndExit);
  process.on('SIGTERM', shutdownAndExit);
}

/** False when the port is taken: a second stdio client keeps stdio and leaves HTTP to the first process. */
function listenOnLoopback(server: Server): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        log(`Port ${HTTP_PORT} is already in use on ${LOOPBACK_HOST}. Serving stdio only.`);
        resolve(false);
        return;
      }
      reject(error);
    });
    server.listen(HTTP_PORT, LOOPBACK_HOST, () => resolve(true));
  });
}

main().catch((error: unknown) => {
  log(errorMessage(error, 'The process failed.'));
  process.exitCode = 1;
});

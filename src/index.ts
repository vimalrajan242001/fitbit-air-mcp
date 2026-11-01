import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { HTTP_PORT, LOOPBACK_HOST } from './constants.js';
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
  // A second stdio client finds the port taken: it keeps stdio and leaves HTTP to the first process.
  const listening = await new Promise<boolean>((resolve, reject) => {
    httpServer.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        log(`Port ${HTTP_PORT} is already in use on ${LOOPBACK_HOST}. Serving stdio only.`);
        resolve(false);
        return;
      }
      reject(error);
    });
    httpServer.listen(HTTP_PORT, LOOPBACK_HOST, () => resolve(true));
  });
  if (listening) log(`fitbit-air-mcp listening on stdio and http://${LOOPBACK_HOST}:${HTTP_PORT}/mcp`);
  const stdio = serveStdio(() => createFitbitServer());
  const shutdown = async (): Promise<void> => {
    if (listening) httpServer.close();
    await stdio.close();
  };
  process.stdin.on('end', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : 'The process failed.');
  process.exitCode = 1;
});

import { createServer, type Server } from 'node:http';

import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';

/** Streamable MCP on /mcp. The caller binds 127.0.0.1:8788. */
export function createMcpHttpServer(factory: () => McpServer): Server {
  const handler = createMcpHandler(factory);
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  return createServer((request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    const path = (request.url ?? '/').split('?')[0];
    if (path !== '/mcp') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    void nodeHandler(request, response);
  });
}

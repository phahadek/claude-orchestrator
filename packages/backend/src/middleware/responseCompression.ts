import compression from 'compression';
import type { RequestHandler } from 'express';
import { ORCHESTRATOR_MCP_FULL_PATH } from '../mcp/orchestratorMcpServer';

/**
 * gzip/brotli-encodes JSON API and static responses above the default 1 KB
 * threshold. Excludes the MCP router's streamable-HTTP path (its
 * StreamableHTTPServerTransport responses can be SSE-capable and must not be
 * buffered for compression) and any text/event-stream response.
 */
export function createResponseCompression(): RequestHandler {
  return compression({
    filter: (req, res) => {
      if (req.path.startsWith(ORCHESTRATOR_MCP_FULL_PATH)) return false;
      // res.send() of a string appends "; charset=utf-8", so match by prefix.
      const contentType = res.getHeader('Content-Type');
      if (
        typeof contentType === 'string' &&
        contentType.startsWith('text/event-stream')
      ) {
        return false;
      }
      return compression.filter(req, res);
    },
  });
}

/**
 * The `node:http` adapter.
 *
 * The only file in the platform that knows a socket exists. Everything above it is a function from
 * a request object to a response object, which is why the API suites run in milliseconds and never
 * bind a port.
 *
 * Owned by: platform substrate.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { handleRequest, type PipelineOptions, type RawRequest } from './pipeline.ts';

export interface ServerOptions extends PipelineOptions {
  /** Largest body accepted, in bytes. Enforced while reading, not after. */
  readonly maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/**
 * Read the body, refusing to buffer more than the limit.
 *
 * The limit is enforced **as the bytes arrive**, not after the body is complete: checking afterwards
 * means a client can make the process hold a gigabyte in memory before being told the limit is a
 * megabyte, which is a denial of service with extra steps. Resolving `null` means "over the limit",
 * and the pipeline turns that into a 413.
 */
function readBody(request: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    request.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) {
        aborted = true;
        // Stop reading. The socket is drained by destroying it rather than by consuming a body the
        // request has already forfeited.
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!aborted) resolve(chunks.length === 0 ? null : Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', (error) => {
      if (!aborted) reject(error);
    });
  });
}

function lowerCaseHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

/** Build a server. Not started: the caller decides when and on what port. */
export function createHttpServer(options: ServerOptions): Server {
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    void (async () => {
      const headers = lowerCaseHeaders(incoming);
      let body: string | null;
      try {
        body = await readBody(incoming, limit);
      } catch {
        // A socket that died mid-body has nobody left to answer.
        outgoing.destroy();
        return;
      }
      // `readBody` resolves null both for "no body" and for "over the limit". They are told apart by
      // whether the client announced one: a request with a content-length that produced no buffered
      // body is one whose body was refused.
      const overLimit = body === null && (headers['content-length'] ?? '') !== '';

      const raw: RawRequest = {
        method: incoming.method ?? 'GET',
        target: incoming.url ?? '/',
        headers,
        // A body that blew the limit is passed through as a very long string so the pipeline's own
        // limit check produces the 413, keeping the decision in one place.
        body: overLimit ? 'x'.repeat(limit + 1) : body,
      };

      const response = await handleRequest(options, raw);
      const payload = response.body === null ? '' : JSON.stringify(response.body);

      outgoing.writeHead(response.status, {
        ...(response.body === null ? {} : { 'content-type': 'application/json' }),
        ...response.headers,
        'content-length': Buffer.byteLength(payload, 'utf8'),
      });
      outgoing.end(payload);
    })();
  });
}

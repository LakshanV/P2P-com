/**
 * The HTTP shapes the application is written against.
 *
 * Handlers take a plain request object and return a plain response object. Nothing in a handler
 * touches a socket, so the whole API surface can be tested by calling functions — which is the
 * difference between a suite that runs in milliseconds and one that binds ports.
 *
 * The adapter in `server.ts` is the only code that knows `node:http` exists.
 *
 * Owned by: platform substrate.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * A request, already parsed.
 *
 * `body` is `unknown` rather than a typed shape: it came from outside the platform, and the only
 * honest type for something a stranger sent is one that forces the handler to check.
 */
export interface HttpRequest {
  readonly method: HttpMethod;
  /** Path only — no query string, no origin. */
  readonly path: string;
  /** Lower-cased header names, so a handler never has to guess at capitalisation. */
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  /** Path parameters, filled in by the router from the matched route. */
  readonly params: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Serialised as JSON. `null` means no body, which is what a 204 sends. */
  readonly body: unknown;
}

export type HttpHandler = (request: HttpRequest) => Promise<HttpResponse>;

/** A JSON response with no ceremony. */
export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponse {
  return { status, headers, body };
}

/** 204: it worked and there is nothing to say about it. */
export function noContent(headers: Record<string, string> = {}): HttpResponse {
  return { status: 204, headers, body: null };
}

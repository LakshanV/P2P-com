/**
 * The request pipeline: everything that happens to a request before and after a handler sees it.
 *
 * Routing, correlation, body limits, content-type checking, and turning an exception into a
 * response. Handlers get to assume all of it has already happened, which is what keeps them short
 * enough to read.
 *
 * The pipeline holds **no business knowledge**. It does not know what an order is, and it maps no
 * module's error codes — the application supplies that as `describe`. A substrate that knew M-11's
 * refusal codes would have to change every time a module did.
 *
 * Owned by: platform substrate.
 */

import { toJsonSafe } from './json.ts';
import { internalError, problem } from './problem.ts';
import { splitTarget, type Router } from './router.ts';
import { HTTP_METHODS, type HttpMethod, type HttpRequest, type HttpResponse } from './types.ts';

/**
 * How the application describes one of its own refusals to the pipeline.
 *
 * Returning null means "I do not recognise this", and the pipeline reports a 500 — which is the
 * right answer, because an error nobody classified is a bug rather than a client mistake.
 */
export type DescribeError = (
  error: unknown,
) => { readonly status: number; readonly code: string; readonly detail: string } | null;

export interface PipelineOptions {
  readonly router: Router;
  readonly describe: DescribeError;
  /**
   * Called for every request once it is finished, with the outcome.
   *
   * The single observability hook. An application wires structured logging or metrics here rather
   * than the pipeline choosing a logger for it.
   */
  readonly observe?: (record: RequestRecord) => void;
  /** Correlation id for a request that did not bring one. */
  readonly correlationFor: (request: RawRequest) => string;
  /** Largest body accepted, in bytes. */
  readonly maxBodyBytes?: number;
}

export interface RawRequest {
  readonly method: string;
  /** Path and query, exactly as the client sent it. */
  readonly target: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The body as text, or null when there was none. */
  readonly body: string | null;
}

export interface RequestRecord {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly correlationId: string;
  /** The refusal code, when the response was a problem. */
  readonly code: string | null;
  /** Set when the pipeline caught something it could not classify. */
  readonly unclassified: unknown;
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/**
 * Handle one request, from raw text to a response.
 *
 * **Nothing in here throws.** Every path either returns a response or is caught and turned into
 * one, because a pipeline that can throw leaves the adapter above it deciding what a half-handled
 * request looks like — and the adapter has even less information than this does.
 */
export async function handleRequest(
  options: PipelineOptions,
  raw: RawRequest,
): Promise<HttpResponse> {
  const correlationId = options.correlationFor(raw);
  const { path, query } = splitTarget(raw.target);
  let record: RequestRecord = {
    method: raw.method,
    path,
    status: 500,
    correlationId,
    code: null,
    unclassified: null,
  };

  const finish = (
    response: HttpResponse,
    code: string | null,
    unclassified: unknown = null,
  ): HttpResponse => {
    record = { ...record, status: response.status, code, unclassified };
    options.observe?.(record);
    return {
      ...response,
      // Every response carries the correlation id, success or failure. A client that can only quote
      // one thing when something goes wrong should be able to quote it whatever happened.
      headers: { ...response.headers, 'x-correlation-id': correlationId },
      // Every bigint becomes its decimal string here rather than at the socket, so a test that
      // calls this function sees exactly what a client receives. `JSON.stringify` throws on a
      // bigint, so without this a response carrying an order total would fail *after* the work had
      // been committed — a 500 for a request that succeeded.
      body: toJsonSafe(response.body),
    };
  };

  const refuse = (status: number, code: string, detail: string): HttpResponse =>
    finish(problem({ status, code, detail, correlationId }), code);

  if (!isMethod(raw.method)) {
    return refuse(405, 'method-not-supported', `${raw.method} is not a method this API accepts.`);
  }

  const matched = options.router.match(raw.method, path);
  if (matched.kind === 'not-found') {
    return refuse(404, 'no-such-route', `There is no resource at ${path}.`);
  }
  if (matched.kind === 'method-not-allowed') {
    const allowed = (matched.allowed ?? []).join(', ');
    const response = problem({
      status: 405,
      code: 'method-not-allowed',
      detail: `${path} exists, but not for ${raw.method}. It accepts ${allowed}.`,
      correlationId,
    });
    return finish(
      { ...response, headers: { ...response.headers, allow: allowed } },
      'method-not-allowed',
    );
  }

  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (raw.body !== null && Buffer.byteLength(raw.body, 'utf8') > limit) {
    return refuse(
      413,
      'body-too-large',
      `The request body exceeds ${String(limit)} bytes. Send less, or page the work.`,
    );
  }

  let body: unknown = null;
  if (raw.body !== null && raw.body !== '') {
    const contentType = raw.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return refuse(
        415,
        'unsupported-media-type',
        `This API accepts application/json. The request declared "${contentType}".`,
      );
    }
    try {
      body = JSON.parse(raw.body);
    } catch {
      // The parser's own message names a character offset, which tells a client nothing they can
      // act on and occasionally echoes their payload back at them.
      return refuse(400, 'malformed-json', 'The request body is not valid JSON.');
    }
  }

  const request: HttpRequest = {
    method: raw.method,
    path,
    headers: raw.headers,
    query,
    params: matched.params ?? {},
    body,
  };

  try {
    const response = await (matched.route?.handler(request) ??
      Promise.resolve(
        problem({ status: 500, code: 'no-handler', detail: 'unreachable', correlationId }),
      ));
    return finish(response, null);
  } catch (error) {
    const described = options.describe(error);
    if (described === null) {
      // Unclassified: reported as a plain 500 and handed to the observer in full, because this is a
      // defect and the detail belongs in a log rather than in a response to a stranger.
      return finish(internalError(correlationId), 'internal-error', error);
    }
    return finish(
      problem({
        status: described.status,
        code: described.code,
        detail: described.detail,
        correlationId,
      }),
      described.code,
    );
  }
}

function isMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

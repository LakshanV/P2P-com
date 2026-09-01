/**
 * Error responses, as RFC 9457 problem details.
 *
 * Every refusal this platform makes already carries a machine-readable `code` — that is the whole
 * point of the error classes in every module — and the API's job is to get that code to the client
 * without losing it. A body of `{"error": "something went wrong"}` throws away the one part a caller
 * can act on.
 *
 * So a problem response carries:
 *
 *   * `status` and `title`, for a human reading a log;
 *   * `code`, the module's own refusal code, which is what a client branches on;
 *   * `detail`, the module's message, which explains why;
 *   * `correlationId`, so the client can quote one thing when they ask what happened.
 *
 * **A refusal never carries an internal message it did not mean to.** An unexpected exception is
 * reported as a plain 500 with a generic detail: the stack trace and the driver's error text go to
 * the log, not to the caller. A database error message can name a table, a constraint and sometimes
 * a value, and none of that is the client's business.
 *
 * Owned by: platform substrate.
 */

import type { HttpResponse } from './types.ts';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  /** The refusing component's own code, which is what a client branches on. */
  readonly code: string;
  readonly correlationId: string;
  /** Field-level detail, when the refusal was about the request's shape. */
  readonly errors?: Readonly<Record<string, string>>;
}

/** The titles that go with the statuses this platform actually returns. */
const TITLES: Readonly<Record<number, string>> = Object.freeze({
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
});

export function problem(options: {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly correlationId: string;
  readonly errors?: Readonly<Record<string, string>>;
}): HttpResponse {
  const body: ProblemDetails = {
    // A stable, resolvable-looking URI per code, so a client can key on `type` if it prefers.
    type: `https://jaya.lk/problems/${options.code}`,
    title: TITLES[options.status] ?? 'Error',
    status: options.status,
    detail: options.detail,
    code: options.code,
    correlationId: options.correlationId,
    ...(options.errors === undefined ? {} : { errors: options.errors }),
  };

  return {
    status: options.status,
    headers: { 'content-type': PROBLEM_CONTENT_TYPE, 'x-correlation-id': options.correlationId },
    body,
  };
}

/**
 * The response for an exception nobody expected.
 *
 * Deliberately says nothing. Whatever went wrong is worth logging in full and worth telling the
 * caller nothing about: a driver error names tables and constraints, and an unhandled exception's
 * message is written for a developer, not for a stranger.
 */
export function internalError(correlationId: string): HttpResponse {
  return problem({
    status: 500,
    code: 'internal-error',
    detail: 'The request could not be completed. Quote the correlation id when reporting this.',
    correlationId,
  });
}

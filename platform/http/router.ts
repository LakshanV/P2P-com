/**
 * A router.
 *
 * Small on purpose: exact segments and `:name` parameters, and nothing else. No wildcards, no
 * regular expressions, no optional segments. Every route this platform needs is a fixed shape with
 * identifiers in it, and a router that could express more would mostly be a way to write a route
 * two people read differently.
 *
 * **A path that exists under another method answers 405, not 404.** The difference matters to a
 * client: 404 says "there is nothing here, stop asking", and 405 says "you asked the wrong way".
 * Collapsing them is a small dishonesty that costs somebody an afternoon.
 *
 * Owned by: platform substrate.
 */

import type { HttpHandler, HttpMethod, HttpRequest, HttpResponse } from './types.ts';

export interface Route {
  readonly method: HttpMethod;
  /** `/orders/:orderId/items` — segments beginning with `:` are parameters. */
  readonly path: string;
  readonly handler: HttpHandler;
  /** What this route is for, in one line. Read by the route inventory test. */
  readonly summary: string;
}

interface CompiledRoute extends Route {
  readonly segments: readonly string[];
}

export interface MatchResult {
  readonly kind: 'matched' | 'method-not-allowed' | 'not-found';
  readonly route?: CompiledRoute;
  readonly params?: Readonly<Record<string, string>>;
  /** For a 405, what the client could have used. */
  readonly allowed?: readonly HttpMethod[];
}

function split(path: string): readonly string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/**
 * A route's shape, with parameter names erased.
 *
 * `/orders/:id` and `/orders/:other` are the same route wearing different labels: both match
 * exactly the same paths, so registering both means one is unreachable and which one is an accident
 * of declaration order. Comparing the literal paths would miss that.
 */
function shape(segments: readonly string[]): string {
  return segments.map((segment) => (segment.startsWith(':') ? ':' : segment)).join('/');
}

export class Router {
  readonly #routes: CompiledRoute[] = [];

  add(route: Route): this {
    const segments = split(route.path);
    const duplicate = this.#routes.find(
      (existing) =>
        existing.method === route.method && shape(existing.segments) === shape(segments),
    );
    if (duplicate !== undefined) {
      throw new Error(
        `two routes claim ${route.method} ${route.path}. One of them would never be reached, and ` +
          'which one is an accident of declaration order',
      );
    }
    this.#routes.push({ ...route, segments });
    return this;
  }

  /** Every route, for an inventory or a generated document. */
  routes(): readonly Route[] {
    return Object.freeze(this.#routes.map((route) => ({ ...route })));
  }

  match(method: HttpMethod, path: string): MatchResult {
    const segments = split(path);
    const sameShape = this.#routes.filter((route) => matches(route.segments, segments) !== null);

    if (sameShape.length === 0) return { kind: 'not-found' };

    const route = sameShape.find((candidate) => candidate.method === method);
    if (route === undefined) {
      return {
        kind: 'method-not-allowed',
        allowed: Object.freeze([...new Set(sameShape.map((candidate) => candidate.method))]),
      };
    }

    return { kind: 'matched', route, params: matches(route.segments, segments) ?? {} };
  }
}

/** The parameters this route binds for this path, or null when the shapes differ. */
function matches(
  routeSegments: readonly string[],
  pathSegments: readonly string[],
): Record<string, string> | null {
  if (routeSegments.length !== pathSegments.length) return null;

  const params: Record<string, string> = {};
  for (const [index, expected] of routeSegments.entries()) {
    const actual = pathSegments[index];
    if (actual === undefined) return null;
    if (expected.startsWith(':')) {
      // An empty parameter is not a match. `/orders//items` names no order, and treating it as one
      // would send an empty string into a module that would then refuse it less helpfully.
      if (actual === '') return null;
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

/** Parse a request target into a path and a query, without pulling in a URL parser. */
export function splitTarget(target: string): {
  readonly path: string;
  readonly query: Record<string, string>;
} {
  const index = target.indexOf('?');
  if (index === -1) return { path: target, query: {} };

  const query: Record<string, string> = {};
  for (const pair of target.slice(index + 1).split('&')) {
    if (pair === '') continue;
    const equals = pair.indexOf('=');
    const rawKey = equals === -1 ? pair : pair.slice(0, equals);
    const rawValue = equals === -1 ? '' : pair.slice(equals + 1);
    try {
      query[decodeURIComponent(rawKey.replace(/\+/g, ' '))] = decodeURIComponent(
        rawValue.replace(/\+/g, ' '),
      );
    } catch {
      // A malformed escape is dropped rather than crashing the request. The handler will refuse a
      // missing parameter with a message that names it, which is more use than a decode error.
    }
  }
  return { path: target.slice(0, index), query };
}

export type { HttpHandler, HttpRequest, HttpResponse };

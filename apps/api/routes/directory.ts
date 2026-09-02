/**
 * The supplier and merchant directory over HTTP: how a business joins the network.
 *
 * This is the route that turns an empty marketplace into one somebody can be found in. Until it
 * existed, M-48's data could only be written by a test, so the two sourcing rungs that read it were
 * wired to a table nobody could put anything in.
 *
 * Four properties the routes exist to keep, none of which the module can enforce on its own because
 * none of them is about the record — they are about who is asking.
 *
 * **Nobody registers anybody else.** The account comes from the session. There is no `accountId`
 * field, and sending one is refused rather than ignored, because a caller who could name the party
 * could register a competitor and then close them.
 *
 * **Registration is not admission, and the two are different verbs.** A party registers and edits
 * their own entry under `create`/`update`; letting them into the market is `admit`, which no
 * trading role holds. A supplier who could activate themselves would make the pending state
 * decorative, and the first tender would go to whoever registered fastest.
 *
 * **A supplier reaches their own entry and no other.** Object-level ownership resolves a directory
 * entry to the one account that trades under it. `GET /v1/suppliers/me` exists so the ordinary case
 * needs no identifier at all: a client that has to know its own supplier id to ask about itself is
 * a client that will get it from somewhere it should not.
 *
 * **A search is gated on a category.** M-48 refuses an ungated query and this route does not work
 * around it: "every supplier on the platform" is the commercial map, and a sourcing endpoint is
 * exactly where it would leave.
 *
 * Owned by: apps/api.
 */

import type { DirectoryService } from '../../../modules/supplier-directory/index.ts';
import type { RequestContext } from '../../../platform/http/context.ts';
import type { Route, Router } from '../../../platform/http/router.ts';
import { json, type HttpRequest, type HttpResponse } from '../../../platform/http/types.ts';

import { ApiError } from '../errors.ts';
import { readString } from '../reading.ts';

export interface DirectoryRoutesOptions {
  readonly directory: DirectoryService;
  readonly contextFor: (request: HttpRequest) => RequestContext;
  readonly accountFor: (request: HttpRequest) => string;
}

/**
 * Fields a caller may not send.
 *
 * `accountId` is the party — the session decides it. The rest are facts other components own or
 * decisions this platform makes: a caller who could send `status` would admit themselves, and one
 * who could send `verified` would be answering M-02's question about themselves.
 */
const ASSERTED_FIELDS: readonly string[] = [
  'accountId',
  'account_id',
  'supplierId',
  'supplier_id',
  'status',
  'acceptsOrders',
  'accepts_orders',
  'verified',
  'verificationLevel',
  'reliabilityPerMille',
  'rating',
];

function assertDoesNotAssertTheParty(body: unknown, allow: readonly string[] = []): void {
  if (typeof body !== 'object' || body === null) return;
  for (const field of ASSERTED_FIELDS) {
    if (allow.includes(field)) continue;
    if (field in (body as Record<string, unknown>)) {
      throw new ApiError(
        400,
        'caller-asserted-party',
        `"${field}" is not a field a caller may send. The party is whoever is signed in, and ` +
          'whether they are in the market, verified or reliable is decided elsewhere — a request ' +
          'that could state any of them would be a business writing its own credentials.',
      );
    }
  }
}

/** Read an optional boolean, refusing anything that is not one rather than coercing it. */
function readBoolean(body: unknown, field: string): boolean {
  if (typeof body !== 'object' || body === null || !(field in (body as Record<string, unknown>))) {
    throw new ApiError(400, 'missing-field', `"${field}" is required.`);
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'boolean') {
    throw new ApiError(
      400,
      'malformed-field',
      `"${field}" must be true or false. A string "false" is true in most languages, and a ` +
        'supplier closed for the week is not somebody to guess about.',
    );
  }
  return value;
}

export function directoryRoutes(options: DirectoryRoutesOptions): readonly Route[] {
  const { directory, contextFor, accountFor } = options;

  /**
   * The caller's own entry, by the session rather than by an identifier in the path.
   *
   * A 404 rather than a 403 when it is somebody else's, for the reason every other route here uses
   * one: telling a stranger that a supplier id exists is telling them something about a business
   * that did not ask them to know it.
   */
  async function requireOwnEntry(request: HttpRequest): Promise<string> {
    const supplierId = request.params.supplierId ?? '';
    const entry = await directory.getSupplier(supplierId);
    if (entry === null || entry.accountId !== accountFor(request)) {
      throw new ApiError(404, 'not-found', 'No such directory entry.');
    }
    return supplierId;
  }

  return [
    // -----------------------------------------------------------------------
    // Joining
    // -----------------------------------------------------------------------

    {
      method: 'POST',
      path: '/v1/suppliers',
      summary: 'Register to trade. Starts pending and closed for orders: joining is not admission.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        assertDoesNotAssertTheParty(request.body);

        const result = await directory.registerSupplier({
          supplierId: context.derivedId('sup', 'directory'),
          // The session, never the body. This is the whole reason the field above is refused.
          accountId: accountFor(request),
          kind: readString(request.body, 'kind'),
          displayName: readString(request.body, 'displayName'),
          registeredAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
          eventId: context.derivedId('dev', 'registered'),
        });

        return json(result.replayed ? 200 : 201, result);
      },
    },

    {
      method: 'GET',
      path: '/v1/suppliers/me',
      summary: 'The entry the signed-in party trades under, with everything they have declared.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const entry = await directory.getSupplierForAccount(accountFor(request));
        if (entry === null) {
          throw new ApiError(
            404,
            'not-registered',
            'You are not in the directory. Register first: an account that trades and an account ' +
              'that shops are the same account here, so this being empty is not an error about you.',
          );
        }
        return json(200, {
          entry,
          profile: await directory.getProfile(entry.supplierId),
        });
      },
    },

    {
      method: 'GET',
      path: '/v1/suppliers/:supplierId',
      // The party's own entry, including while it is still pending. A buyer sees other parties
      // through the gated search and not through this route, which is what keeps a party who has
      // registered and not been admitted invisible to everybody but themselves.
      summary: 'Your own directory entry and its declarations.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const supplierId = request.params.supplierId ?? '';
        const profile = await directory.getProfile(supplierId);
        if (profile === null) {
          throw new ApiError(404, 'not-found', 'No such directory entry.');
        }
        return json(200, { entry: profile.entry, profile });
      },
    },

    // -----------------------------------------------------------------------
    // What a party says about itself
    // -----------------------------------------------------------------------

    {
      method: 'PUT',
      path: '/v1/suppliers/:supplierId/availability',
      summary: 'Open or close for orders, and state a daily ceiling. Not the same as status.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        assertDoesNotAssertTheParty(request.body, ['acceptsOrders']);
        const supplierId = await requireOwnEntry(request);

        const body = (request.body ?? {}) as Record<string, unknown>;
        const result = await directory.setAvailability({
          supplierId,
          acceptsOrders: readBoolean(request.body, 'acceptsOrders'),
          // Absent means "not stated", which M-48 keeps distinct from zero: a supplier who has not
          // filled in a ceiling is not a supplier who can take nothing.
          ...('dailyCapacity' in body ? { dailyCapacity: body.dailyCapacity } : {}),
          occurredAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });

        return json(200, result);
      },
    },

    {
      method: 'GET',
      path: '/v1/suppliers/:supplierId/facets',
      summary: 'What this party has declared it deals in, including what it has withdrawn.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { facets: await directory.listFacets(request.params.supplierId ?? '') }),
    },

    {
      method: 'POST',
      path: '/v1/suppliers/:supplierId/facets',
      summary: 'Declare a category, brand, capability or service district.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        assertDoesNotAssertTheParty(request.body);
        const supplierId = await requireOwnEntry(request);

        const result = await directory.declareFacet({
          facetId: context.derivedId('fac', 'facet'),
          supplierId,
          kind: readString(request.body, 'kind'),
          value: readString(request.body, 'value'),
          declaredAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });

        return json(result.replayed ? 200 : 201, result);
      },
    },

    {
      method: 'DELETE',
      path: '/v1/suppliers/:supplierId/facets/:facetKind/:value',
      summary: 'Stop dealing in something. The declaration moves rather than disappearing.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const supplierId = await requireOwnEntry(request);

        const result = await directory.withdrawFacet({
          supplierId,
          kind: request.params.facetKind ?? '',
          value: request.params.value ?? '',
          occurredAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });

        return json(200, result);
      },
    },

    {
      method: 'GET',
      path: '/v1/suppliers/:supplierId/locations',
      summary: 'Where this party trades from, and which branch is the main one.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { locations: await directory.listLocations(request.params.supplierId ?? '') }),
    },

    {
      method: 'POST',
      path: '/v1/suppliers/:supplierId/locations',
      summary: 'Open a branch, in a district. No street address: the platform routes on districts.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        assertDoesNotAssertTheParty(request.body);
        const supplierId = await requireOwnEntry(request);

        const body = (request.body ?? {}) as Record<string, unknown>;
        const result = await directory.addLocation({
          locationId: context.derivedId('loc', 'location'),
          supplierId,
          name: readString(request.body, 'name'),
          district: readString(request.body, 'district'),
          ...('primary' in body ? { primary: readBoolean(request.body, 'primary') } : {}),
          openedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });

        return json(result.replayed ? 200 : 201, result);
      },
    },

    {
      method: 'DELETE',
      path: '/v1/suppliers/:supplierId/locations/:locationId',
      summary: 'Close a branch. It stays on the record, because orders already name it.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        await requireOwnEntry(request);

        const result = await directory.closeLocation({
          locationId: request.params.locationId ?? '',
          occurredAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });

        return json(200, result);
      },
    },

    {
      method: 'GET',
      path: '/v1/suppliers/:supplierId/history',
      summary: 'How this entry reached its status, and why. Append-only, and what an appeal reads.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { history: await directory.listHistory(request.params.supplierId ?? '') }),
    },

    // -----------------------------------------------------------------------
    // Admission: somebody else's decision, and never the party's own
    // -----------------------------------------------------------------------

    {
      method: 'POST',
      path: '/v1/suppliers/:supplierId/status',
      summary: 'Admit a party to the market, suspend them, or close their entry. Reason required.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        assertDoesNotAssertTheParty(request.body, ['status']);

        const supplierId = request.params.supplierId ?? '';
        const entry = await directory.getSupplier(supplierId);
        if (entry === null) {
          throw new ApiError(404, 'not-found', 'No such directory entry.');
        }

        // A party may not admit, suspend or reinstate themselves, and K-04 has already refused the
        // ordinary case by verb. This is the second layer, and it catches the one K-04 cannot:
        // somebody who legitimately holds `admit` deciding their **own** entry.
        if (entry.accountId === accountFor(request)) {
          throw new ApiError(
            409,
            'not-your-decision',
            'A party does not decide whether it is in the market. Registration is not admission, ' +
              'and an entry that could admit itself would make the pending state decorative.',
          );
        }

        const status = readString(request.body, 'status');
        const transition = {
          supplierId,
          reason: readString(request.body, 'reason'),
          occurredAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
          eventId: context.derivedId('dev', status),
        };

        const result =
          status === 'active'
            ? await directory.activateSupplier(transition)
            : status === 'suspended'
              ? await directory.suspendSupplier(transition)
              : status === 'closed'
                ? await directory.closeSupplier(transition)
                : null;

        if (result === null) {
          throw new ApiError(
            400,
            'unknown-status',
            `"${status}" is not a status anybody can be moved to. Expected active, suspended or ` +
              'closed; pending is where an entry starts and is not somewhere it returns to.',
          );
        }

        return json(200, result);
      },
    },

    // -----------------------------------------------------------------------
    // Finding somebody to buy from
    // -----------------------------------------------------------------------

    {
      method: 'GET',
      path: '/v1/suppliers',
      summary: 'Find open suppliers in a category. A category is required, not a convenience.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const categories = listParam(request, 'category');
        if (categories.length === 0) {
          throw new ApiError(
            400,
            'ungated-query',
            'Name at least one category. A directory query with no category asks for every ' +
              'supplier on the platform, which is who trades here and how to reach them — and a ' +
              'sourcing endpoint is not where that leaves.',
          );
        }

        const districts = listParam(request, 'district');
        const kind = request.query.kind;

        const profiles = await directory.findSuppliers({
          categories,
          ...(districts.length === 0 ? {} : { districts }),
          ...(typeof kind === 'string' && kind !== ''
            ? { kind: kind as 'supplier' | 'merchant' }
            : {}),
        });

        return json(200, { suppliers: profiles });
      },
    },
  ];
}

/**
 * A comma-separated query parameter, as a list. `?category=cement,steel`.
 *
 * Comma-separated rather than repeated, because the request layer models the query string as one
 * value per name, and a route that quietly took the last repetition would answer a narrower
 * question than the one asked.
 */
function listParam(request: HttpRequest, name: string): readonly string[] {
  const value = request.query[name];
  if (value === undefined) return [];
  return value
    .split(',')
    .map((one) => one.trim())
    .filter((one) => one !== '');
}

/** Register the directory routes on a router. */
export function addDirectoryRoutes(router: Router, options: DirectoryRoutesOptions): Router {
  for (const route of directoryRoutes(options)) router.add(route);
  return router;
}

/**
 * The database interface the migration runner talks to (FND-002b).
 *
 * The runner never imports a driver. It is written against this interface so that every behaviour
 * that matters — lock acquisition and release, transaction boundaries, ordering, checksum
 * reconciliation, failure paths — is testable deterministically against a fake, without a
 * PostgreSQL server and without the flakiness a live database brings to a unit test.
 *
 * The real adapter lives in postgres.ts and is the only file that knows a driver exists.
 *
 * Owned by: FND-002b (data foundation — migration runner).
 */

export interface QueryResult<Row = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

/**
 * A failed statement, carrying the machine-readable part of the driver's report.
 *
 * The message is redacted and the driver error is deliberately not attached as `cause`, because it
 * may quote the connection string and with it the password. The SQLSTATE and the constraint name
 * carry no credential and are the only reliable way for a caller to tell *which* rule the database
 * enforced — a unique-violation on one index means something quite different from one on another,
 * and deciding that by matching English error text would break the first time a server is
 * configured for a different locale or a driver reworded its output.
 */
export interface DatabaseErrorDetail {
  /** SQLSTATE, e.g. `23505` for a unique violation. Absent if the driver did not report one. */
  readonly code?: string;
  /** The constraint or unique index the statement violated, if the driver named it. */
  readonly constraint?: string;
}

/** Read the SQLSTATE details off a thrown error, whatever threw it. */
export function databaseErrorDetail(error: unknown): DatabaseErrorDetail {
  if (typeof error !== 'object' || error === null) return {};
  const candidate = error as { code?: unknown; constraint?: unknown };
  const detail: { code?: string; constraint?: string } = {};
  if (typeof candidate.code === 'string') detail.code = candidate.code;
  if (typeof candidate.constraint === 'string') detail.constraint = candidate.constraint;
  return detail;
}

/**
 * A single session. The runner holds exactly one for a whole run, because a PostgreSQL
 * session-level advisory lock belongs to the session that took it — spread the run across a pool
 * and the lock protects nothing.
 */
export interface DatabaseClient {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  release(): Promise<void>;
}

export interface Database {
  /** Open the one session this run will use. */
  connect(): Promise<DatabaseClient>;
  /** Human-readable target, with credentials already removed. Safe to log. */
  readonly description: string;
}

/**
 * Render a connection string safely.
 *
 * Connection strings carry a password, and the places they get printed — a startup banner, an
 * error message, a CI log — are exactly the places that get pasted into issues and chat. So the
 * runner never holds a printable connection string: it holds this.
 *
 * Anything that cannot be parsed is reported as `<unparseable connection string>` rather than
 * echoed, because a malformed URL is still likely to contain the password.
 */
export function redactConnectionString(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '<unparseable connection string>';
  }

  const user = url.username === '' ? '' : `${url.username}${url.password === '' ? '' : ':***'}@`;
  const port = url.port === '' ? '' : `:${url.port}`;
  const database = url.pathname === '' || url.pathname === '/' ? '' : url.pathname;
  const hasSearch = [...url.searchParams.keys()].length > 0;
  const query = hasSearch ? `?${[...url.searchParams.keys()].sort().join(',')}=…` : '';

  return `${url.protocol}//${user}${url.hostname}${port}${database}${query}`;
}

/**
 * Strip a password out of arbitrary text — an error message from a driver, say, which may quote
 * the connection string it failed on. Belt and braces alongside redactConnectionString: the
 * runner passes every message it prints through this.
 */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== '') out = out.split(secret).join('***');
  }
  // A URL userinfo section that survived the loop above, e.g. from a driver's own formatting.
  return out.replace(/\/\/([^\s:/@]+):([^\s@/]+)@/g, '//$1:***@');
}

/** The password inside a connection string, or '' when there is none. Never logged. */
export function passwordOf(raw: string): string {
  try {
    return new URL(raw).password;
  } catch {
    return '';
  }
}

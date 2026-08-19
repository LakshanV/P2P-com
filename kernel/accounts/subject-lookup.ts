/**
 * K-03 Accounts — how this component asks K-01 whether a subject exists (FND-004b).
 *
 * This is the whole surface of the dependency: **one question, asked through K-01's public
 * contract**, and no other coupling of any kind. K-03 does not read K-01's tables, does not declare
 * a foreign key into `kernel_identity`, and does not import K-01's repository or adapter. It asks a
 * port.
 *
 * ## Why a port and not a foreign key
 *
 * A cross-schema foreign key would be the obvious way to make "an account names a real subject"
 * true, and it is the wrong one here.
 *
 *   - **It makes the two components one.** `kernel_identity` could not be migrated, rolled back or
 *     moved to another database without `kernel_accounts`' permission, and the schema-ownership
 *     rule (MODULE_MAP §10) exists precisely so that each unit owns its own namespace outright.
 *     K-01's rollback uses `RESTRICT`; a foreign key from here would make that rollback fail for a
 *     reason no K-01 migration mentions.
 *   - **It is enforcement in the wrong layer.** The interesting refusal is "this subject does not
 *     exist", raised *before* an account transaction opens, with a message naming the subject. A
 *     foreign-key violation arrives as SQLSTATE 23503 after the write, and every caller has to
 *     translate it back.
 *
 * What is given up is stated rather than glossed: **there is no database-level guarantee that
 * `subject_id` names a real subject.** A row inserted around this component can name anything the
 * opacity rules accept. That cost is small today because K-01 subjects are write-once — nothing
 * deletes one, so a link checked at creation stays valid — and it is recorded in CONTRACT.md §5
 * rather than left for somebody to discover.
 *
 * ## Why `exists` and nothing more
 *
 * The port could hand back the whole subject, and then K-03 would be able to make decisions about
 * a subject's `kind` — whether a `system` actor may hold an account, say. That is a rule this slice
 * has no mandate to invent, and a port shaped to allow it invites somebody to. Asking only the
 * question that has to be answered keeps the coupling at exactly one bit.
 *
 * `IdentityService` satisfies this interface structurally, which is the point: no adapter, no
 * translation layer, and `tests/accounts.test.ts` wires the real K-01 service to the real K-03
 * service to prove it.
 *
 * Owned by: K-03 Accounts. The *contract* is K-03's, because a consumer defines what it needs; the
 * *implementation* is K-01's.
 */

/** The one question K-03 asks K-01. */
export interface SubjectLookup {
  /** Does this identity subject exist? */
  exists(subjectId: string): Promise<boolean>;
}

/**
 * A lookup that reports no subject at all.
 *
 * For tests that need the unknown-subject path, and for a caller that genuinely has no identity
 * component wired yet — which fails closed, refusing every creation, rather than silently
 * accepting accounts for parties nobody has heard of.
 */
export const NO_SUBJECTS: SubjectLookup = {
  exists(): Promise<boolean> {
    return Promise.resolve(false);
  },
};

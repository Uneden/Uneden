/**
 * Minimal stand-in for the pg Pool: each query is answered by the first
 * handler whose pattern matches its SQL, and every query is recorded so tests
 * can assert what was written (and in which transaction state).
 *
 *   const db = createFakeDb();
 *   db.on(/FROM payments/, () => [{ id: "p1", status: "pending" }]);
 *   vi.mock("../src/config/db.js", () => ({ default: db.pool }));
 */
export function createFakeDb() {
  const handlers = [];
  const queries = [];

  async function query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, " ").trim();
    queries.push({ sql: text, params });
    for (const [pattern, handler] of handlers) {
      if (pattern.test(text)) {
        const result = await handler(params, text);
        if (result instanceof Error) throw result;
        const rows = Array.isArray(result) ? result : result?.rows ?? [];
        return { rows, rowCount: result?.rowCount ?? rows.length };
      }
    }
    return { rows: [], rowCount: 0 };
  }

  const client = { query, release: () => {} };
  const pool = { query, connect: async () => client, on: () => {} };

  return {
    pool,
    queries,
    /** Answer queries matching pattern with handler(params, sql) → rows | { rows, rowCount } | Error. */
    on(pattern, handler) {
      handlers.unshift([pattern, handler]);
      return this;
    },
    reset() {
      handlers.length = 0;
      queries.length = 0;
    },
    /** Queries whose SQL matches pattern. */
    find(pattern) {
      return queries.filter((q) => pattern.test(q.sql));
    },
  };
}

/**
 * Reads the column types declared by supabase/migrations (baseline + later
 * ALTER ... TYPE), so tests can check that what the code writes fits the
 * columns instead of discovering it as a 500 in production.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(MIGRATIONS_DIR + name, "utf8").replace(/\r\n/g, "\n"));
}

function cleanType(raw) {
  return raw.replace(/"/g, "").trim().toLowerCase();
}

/** @returns {Map<string, string>} "table.column" → SQL type, e.g. "character varying(100)" */
export function loadColumnTypes() {
  const types = new Map();
  for (const sql of migrationFiles()) {
    for (const [, table, body] of sql.matchAll(
      /CREATE TABLE IF NOT EXISTS "public"\."(\w+)" \(([\s\S]*?)\n\);/g,
    )) {
      for (const line of body.split("\n")) {
        const column = line.match(/^\s*"(\w+)" (.+?)(?: DEFAULT .*| NOT NULL.*|,)?$/);
        if (column) types.set(`${table}.${column[1]}`, cleanType(column[2]));
      }
    }
    for (const [, table, column, type] of sql.matchAll(
      /ALTER TABLE (?:ONLY )?(?:"?public"?\.)?"?(\w+)"? ALTER COLUMN "?(\w+)"? TYPE ([^;]+);/gi,
    )) {
      types.set(`${table}.${column}`, cleanType(type));
    }
  }
  return types;
}

const columnTypes = loadColumnTypes();

export function columnType(table, column) {
  const type = columnTypes.get(`${table}.${column}`);
  if (!type) throw new Error(`Column ${table}.${column} not found in supabase/migrations`);
  return type;
}

/** Max characters a text column accepts (Infinity for text). */
export function maxChars(table, column) {
  const type = columnType(table, column);
  if (type === "text") return Infinity;
  const sized = type.match(/^(?:character varying|varchar|character|char)\((\d+)\)$/);
  if (sized) return Number(sized[1]);
  throw new Error(`${table}.${column} is ${type}, not a text type`);
}

/** Largest value a numeric column accepts (Infinity when unbounded). */
export function maxNumeric(table, column) {
  const type = columnType(table, column);
  if (type === "numeric" || type === "integer" || type === "double precision") {
    return type === "integer" ? 2 ** 31 - 1 : Infinity;
  }
  const sized = type.match(/^numeric\((\d+),\s*(\d+)\)$/);
  if (sized) {
    const [precision, scale] = [Number(sized[1]), Number(sized[2])];
    return 10 ** (precision - scale) - 10 ** -scale;
  }
  throw new Error(`${table}.${column} is ${type}, not a numeric type`);
}

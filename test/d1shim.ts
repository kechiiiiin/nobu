// テスト用: node:sqlite の上に D1 の必要な分だけの口を作る（prepare/bind/first/all/run/batch/exec）
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

type Val = string | number | null;

class Stmt {
  private db: DatabaseSync;
  readonly sql: string;
  readonly params: Val[];
  constructor(db: DatabaseSync, sql: string, params: Val[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params: Val[]) {
    return new Stmt(this.db, this.sql, params);
  }
  rows(): Record<string, unknown>[] {
    return this.db.prepare(this.sql).all(...this.params) as Record<string, unknown>[];
  }
  async first<T>(): Promise<T | null> {
    return ((this.rows()[0] as T) ?? null) as T | null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.rows() as T[] };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(r.changes) } };
  }
}

export function makeDb(
  migrations: string[] = [
    "migrations/0001_init.sql",
    "migrations/0002_reading_session.sql",
    "migrations/0003_repair_reading_session.sql",
    "migrations/0004_paused_and_reading_day.sql",
  ],
) {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON;");
  for (const m of migrations) raw.exec(readFileSync(m, "utf8"));
  const d1 = {
    prepare: (sql: string) => new Stmt(raw, sql),
    async batch(stmts: Stmt[]) {
      raw.exec("BEGIN");
      try {
        const out = stmts.map((s) => ({ results: s.rows() }));
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { raw, db: d1 as unknown as D1Database };
}

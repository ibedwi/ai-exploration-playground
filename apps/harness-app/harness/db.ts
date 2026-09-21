import postgres from "postgres";
import type { AgentEvent } from "@shared/events";

// The durable store for the event log. DBOS keeps its own workflow-checkpoint
// tables in this same Postgres; this table is OURS — the append-only timeline
// the UI replays on connect. (DBOS makes the *execution* durable; this makes the
// *event stream* durable.)

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set — add it to harness-app/.env (see .env.example).");
}

// `ssl: "require"` = connect over TLS (Neon mandates it).
export const sql = postgres(url, { max: 5, ssl: "require" });

export async function ensureSchema(): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS event_log (
    seq  BIGSERIAL PRIMARY KEY,
    data JSONB NOT NULL
  )`;
}

export async function insertEvent(event: AgentEvent): Promise<void> {
  await sql`INSERT INTO event_log (data) VALUES (${sql.json(event as never)})`;
}

export async function selectAllEvents(): Promise<AgentEvent[]> {
  const rows = await sql<{ data: AgentEvent }[]>`SELECT data FROM event_log ORDER BY seq`;
  return rows.map((r) => r.data);
}

export async function truncateEvents(): Promise<void> {
  await sql`TRUNCATE event_log`;
}

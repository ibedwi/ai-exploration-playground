import { randomUUID } from "node:crypto";
import { EventType, type AgentEvent, type EventInput } from "@shared/events";
import { insertEvent, selectAllEvents, truncateEvents } from "./db";

// The harness event bus. Two jobs:
//   1. broadcast each event live to connected inspectors, and
//   2. DURABLY persist it to Postgres so the timeline survives a restart and can
//      be replayed to a browser that connects later.
//
// `emit` stays synchronous for its callers but is `async` internally: it
// broadcasts immediately (in order) and awaits the durable write. The runtime
// awaits it inside DBOS steps, so a completed step's events are persisted before
// the step checkpoints. The one exception is ModelDelta — the token-by-token
// stream is high-frequency and cosmetic (the full text also lands in
// ModelCompleted), so we broadcast deltas live but don't persist them.

type Listener = (event: AgentEvent) => void;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function emit(input: EventInput): Promise<void> {
  const event: AgentEvent = { ...input, id: randomUUID(), ts: Date.now() };
  for (const listener of listeners) listener(event); // live (synchronous, ordered)
  if (event.type !== EventType.ModelDelta) {
    await insertEvent(event); // durable
  }
}

// The full timeline so far, in order — replayed to each inspector on connect.
export async function history(): Promise<AgentEvent[]> {
  return selectAllEvents();
}

// Wipe the timeline (the inspector's "clear" button calls this).
export async function clearLog(): Promise<void> {
  await truncateEvents();
}

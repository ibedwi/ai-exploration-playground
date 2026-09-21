# harness-app

A simplified rebuild of the [harness-engineering](https://) reference app. Three
layers, one idea: **everything the harness does becomes an event on one stream,
and the UI only ever renders that stream.**

```
web/ (React + Vite)  <──WebSocket──>  server/ (Express + ws)  ──calls──>  harness/ (agent loop)
        │                                      │                                  │
   renders the                          broadcasts every                    emits events:
   event stream                         event to clients                    workflow / model / tool
```

## Layout

| Path             | What it is                                                              |
| ---------------- | ---------------------------------------------------------------------- |
| `shared/events.ts` | The event contract between server and browser. The whole system in one file. |
| `harness/db.ts`    | Postgres client + the durable `event_log` table.                       |
| `harness/bus.ts`   | Event bus: `emit` broadcasts live **and** persists to Postgres; `history` replays it. |
| `harness/model.ts` | The model. Real Claude via the AI SDK, or a built-in **mock** if no key.|
| `harness/tools.ts` | Tool schemas the model sees + the executor that runs them.             |
| `harness/agents.ts`| The agent = system prompt + allowed tools.                            |
| `harness/runtime.ts`| **The durable agent loop.** A DBOS workflow: each model turn / tool / approval is a checkpointed step. |
| `server/index.ts`  | Express + WebSocket. Launches DBOS, wires the harness to the browser.   |
| `web/`             | The React inspector: a chat pane + a raw event-stream pane.           |

This app lives in `apps/` but is **standalone** — it's excluded from the pnpm
workspace (its Node backend will later be swapped for FastAPI) and manages its
own deps via `--ignore-workspace`.

## Run it

```bash
pnpm setup    # from apps/harness-app: pull .env from Doppler + install deps
              # (or run scripts/setup.sh from the repo root)
pnpm dev      # server (:8787) + web (:5173) together
```

Open http://localhost:5173 and ask the assistant something, e.g.
_"I'm over budget on dining — can you move $200 to savings?"_

`pnpm setup` (→ `scripts/setup.sh`) pulls secrets from the Doppler project
`ai-playground-harness-app` (config `dev`) into `.env`. Without Doppler, copy
`.env.example` to `.env` and set:
- **`DATABASE_URL`** — a Postgres **direct** connection string (Neon works well).
  DBOS uses it for workflow checkpoints and the event log lives there too.
- **`ANTHROPIC_API_KEY`** — optional; without it the built-in mock model runs.

> First launch runs DBOS migrations and, on a cold Neon compute, can take ~30–60s
> before the server reports `listening`. Subsequent starts are fast.

## How it flows

1. Browser sends `{ type: "submit_task", input }` over the WebSocket.
2. `runAgentWorkflow` starts, emitting `workflow.started`.
3. Each loop step streams the model's text as `model.delta` events, then either:
   - requests tools (`tool.requested` → run → `tool.completed`) and loops, or
   - finishes (`model.completed` → `workflow.completed`).
4. Every event is broadcast to all connected browsers, which fold them into a
   chat transcript (left pane) and a raw timeline (right pane).

## Durable execution (DBOS + Postgres)

The agent loop is a **DBOS workflow**: every model turn, tool call, and approval
is a named, checkpointed step written to Postgres.

- **Crash recovery** — `DBOS.launch()` on startup resumes any workflow that was
  mid-run, replaying completed steps from their checkpoints. The model isn't
  re-prompted and tools aren't re-run.
- **Durable approvals** — a money-moving tool emits `approval.requested`, then the
  workflow SUSPENDS on `DBOS.recv` until the browser answers (`submit_approval`
  → `DBOS.send`). The wait survives a restart.
- **Durable timeline** — `harness/bus.ts` persists every event (except the
  high-frequency `model.delta` stream) to the `event_log` table, so a browser
  that connects later replays the full history.

Inspect it directly:
```sql
SELECT data->>'type', count(*) FROM event_log GROUP BY 1;   -- the timeline
SELECT name, status FROM dbos.workflow_status;              -- DBOS checkpoints
```

## Swapping the backend to FastAPI (later)

The backend is deliberately isolated behind the `shared/events.ts` contract. To
port it to Python/FastAPI you replace `server/` and `harness/` with a FastAPI app
that exposes a WebSocket at `/ws`, accepts the same `ClientMessage`, and emits the
same `AgentEvent` shapes. DBOS has a first-class **Python** library, so the same
durable-workflow pattern carries over. Because the frontend only depends on the
event contract, **the web app doesn't change** — point `useHarnessSocket` at the
new server and it just works.

// MUST be first: loads .env before any module that reads env at load time.
import "./env";

import { DBOS } from "@dbos-inc/dbos-sdk";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { EventType } from "@shared/events";
import { ensureSchema } from "../harness/db";
import { subscribe, history, clearLog } from "../harness/bus";
import { runAgentWorkflow } from "../harness/runtime";
import { usingMock, MODEL_NAME } from "../harness/model";
import type { AgentEvent, ClientMessage } from "@shared/events";

const PORT = Number(process.env.PORT ?? 8787);

// Maps a pending approvalId → the workflow waiting on it, so an incoming
// `submit_approval` (which only carries the approvalId) can be routed to the
// right suspended workflow via DBOS.send. Populated from ApprovalRequested
// events as they flow past.
const approvalRoutes = new Map<string, string>();

async function main() {
  // 1. Our event-log table.
  await ensureSchema();

  // 2. Point DBOS at the same Postgres for its checkpoint store, then launch.
  //    launch() ALSO recovers any workflow that was mid-flight when the process
  //    last died, resuming each from its last completed step.
  DBOS.setConfig({ name: "harness", systemDatabaseUrl: process.env.DATABASE_URL });
  await DBOS.launch();

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*"); // inspector runs on a different port
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true, model: MODEL_NAME, mock: usingMock }));

  app.post("/api/clear", async (_req, res) => {
    await clearLog();
    approvalRoutes.clear();
    res.json({ ok: true });
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  // Forward every emitted event to all connected inspectors, and remember where
  // to route the answer for any approval we see requested.
  subscribe((event: AgentEvent) => {
    if (event.type === EventType.ApprovalRequested) {
      approvalRoutes.set(event.approvalId, event.workflowId);
    }
    const data = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  });

  wss.on("connection", async (socket: WebSocket) => {
    socket.on("message", async (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (message.type === "submit_task") {
        // Start a DURABLE workflow. It streams its progress out as events; the
        // handle isn't awaited so the socket stays responsive.
        await DBOS.startWorkflow(runAgentWorkflow)(message.input);
      } else if (message.type === "submit_approval") {
        // Deliver the decision to the suspended workflow. DBOS.send wakes its
        // recv() — even after a restart. The topic is the approvalId.
        const workflowId = approvalRoutes.get(message.approvalId);
        if (workflowId) {
          approvalRoutes.delete(message.approvalId);
          await DBOS.send(
            workflowId,
            { decision: message.decision, note: message.note },
            message.approvalId,
          );
        }
      }
    });

    // Replay the durable timeline so a fresh inspector sees everything so far
    // (including a workflow DBOS is currently recovering).
    for (const event of await history()) socket.send(JSON.stringify(event));
  });

  server.listen(PORT, () => {
    console.log(`harness server listening on http://localhost:${PORT}  (ws: /ws)`);
    console.log(usingMock ? "  model: MOCK (set ANTHROPIC_API_KEY for real Claude)" : `  model: ${MODEL_NAME}`);
  });
}

main().catch((error) => {
  console.error("failed to start:", error);
  process.exit(1);
});

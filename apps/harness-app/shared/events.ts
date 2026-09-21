// The contract between the harness (server) and the inspector (browser).
//
// EVERYTHING the harness does becomes an event on this stream. That is the whole
// idea: the event log IS the system. The UI never talks to the model or the
// tools directly — it only ever renders this stream.
//
// Every event type is a constant on `EventType`. Import it and use
// `EventType.WorkflowStarted` instead of typing the magic string
// "workflow.started". The compiler catches typos, and autocomplete lists every
// event the harness can emit.
//
// This is the personal-finance build. On top of the generic agent-loop events
// (workflow / model / tool) it adds two finance-specific concerns:
//   1. an APPROVAL GATE — money-moving actions pause the loop until a human
//      confirms them in the UI, and
//   2. a few first-class DOMAIN events (insights, budget alerts) so the UI can
//      render rich cards instead of decoding raw tool JSON.

// Money is always an integer count of the smallest currency unit (cents), never
// a float. `{ amountCents: 4900, currency: "USD" }` is $49.00. This avoids the
// rounding bugs that floating-point dollars invite.
export type Money = { amountCents: number; currency: string };

export enum EventType {
  // ── Generic agent loop ────────────────────────────────────────────────────
  // a workflow (one agent run) begins / ends
  WorkflowStarted = "workflow.started",
  WorkflowCompleted = "workflow.completed",
  WorkflowFailed = "workflow.failed",
  // the model thinking out loud (streamed token by token)
  ModelDelta = "model.delta",
  ModelCompleted = "model.completed",
  // a tool call and its outcome
  ToolRequested = "tool.requested",
  ToolCompleted = "tool.completed",
  ToolFailed = "tool.failed",

  // ── Approval gate (human-in-the-loop) ─────────────────────────────────────
  // The loop emits ApprovalRequested before running a money-moving tool and
  // then blocks. The browser replies with a `submit_approval` ClientMessage,
  // which resolves into exactly one of Granted / Denied.
  ApprovalRequested = "approval.requested",
  ApprovalGranted = "approval.granted",
  ApprovalDenied = "approval.denied",

  // ── Finance domain ────────────────────────────────────────────────────────
  // First-class, UI-renderable finance signals the agent surfaces along the way.
  InsightGenerated = "insight.generated",
  BudgetAlert = "budget.alert",

  // free-form harness logging
  Log = "log",
}

export type EventInput =
  // ── Generic agent loop ────────────────────────────────────────────────────
  | { type: EventType.WorkflowStarted; workflowId: string; input: string }
  | { type: EventType.WorkflowCompleted; workflowId: string; output: string }
  | { type: EventType.WorkflowFailed; workflowId: string; error: string }
  | { type: EventType.ModelDelta; workflowId: string; text: string }
  | { type: EventType.ModelCompleted; workflowId: string; text: string }
  | { type: EventType.ToolRequested; workflowId: string; toolCallId: string; name: string; args: unknown }
  | { type: EventType.ToolCompleted; workflowId: string; toolCallId: string; result: unknown }
  | { type: EventType.ToolFailed; workflowId: string; toolCallId: string; error: string }

  // ── Approval gate ─────────────────────────────────────────────────────────
  // `approvalId` correlates the whole exchange; `toolCallId` ties it back to the
  // pending tool call the gate is guarding. `summary` is the human-readable line
  // the UI shows ("Transfer $500 to Savings"); `amount` powers the confirm card.
  | {
      type: EventType.ApprovalRequested;
      workflowId: string;
      approvalId: string;
      toolCallId: string;
      action: string; // the tool name being gated, e.g. "transferFunds"
      summary: string;
      amount?: Money;
      details?: unknown; // the raw tool args, for the "show details" disclosure
    }
  | { type: EventType.ApprovalGranted; workflowId: string; approvalId: string; note?: string }
  | { type: EventType.ApprovalDenied; workflowId: string; approvalId: string; reason?: string }

  // ── Finance domain ────────────────────────────────────────────────────────
  | {
      type: EventType.InsightGenerated;
      workflowId: string;
      title: string;
      detail: string;
      severity: "info" | "suggestion" | "warning";
      amount?: Money; // e.g. "you could save $32/mo"
    }
  | {
      type: EventType.BudgetAlert;
      workflowId: string;
      category: string; // "Dining", "Groceries", …
      period: string; // "2026-09" (month) or "2026-W38" (week)
      budget: Money;
      spent: Money;
      // spent / budget, precomputed so the UI doesn't redo cents math.
      // >= 1 means over budget.
      ratio: number;
    }

  // ── Logging ───────────────────────────────────────────────────────────────
  | { type: EventType.Log; workflowId?: string; level: "info" | "warn" | "error"; message: string };

// The harness stamps every event with an id + timestamp when it emits.
export type AgentEvent = EventInput & { id: string; ts: number };

// What harness code calls to push an event onto the stream.
export type Emit = (event: EventInput) => void;

// Messages the browser sends back to the server (over the same socket).
//
//  - submit_task     — kick off a new agent run.
//  - submit_approval — answer a pending ApprovalRequested. The `approvalId`
//                      must echo the one from the event; `decision` unblocks the
//                      loop into ApprovalGranted or ApprovalDenied.
export type ClientMessage =
  | { type: "submit_task"; input: string }
  | { type: "submit_approval"; approvalId: string; decision: "approve" | "deny"; note?: string };

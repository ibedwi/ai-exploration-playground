import { EventType, type AgentEvent, type Money } from "@shared/events";

// Fold the raw event stream into a chat transcript. This is the key idea: the
// UI holds NO separate state — the entire conversation is DERIVED from events
// in one pass. Replaying the same events always yields the same transcript.
// (So an approval that was already answered replays as answered — the buttons
// simply aren't offered again.)

export type ToolTurn = {
  kind: "tool";
  id: string;
  toolCallId: string;
  name: string;
  args: unknown;
  state: "running" | "done" | "failed";
  result?: unknown;
  error?: string;
};

export type ApprovalTurn = {
  kind: "approval";
  id: string;
  approvalId: string;
  action: string;
  summary: string;
  amount?: Money;
  details?: unknown;
  state: "pending" | "granted" | "denied";
  note?: string; // approver's note, or the denial reason
};

export type InsightTurn = {
  kind: "insight";
  id: string;
  title: string;
  detail: string;
  severity: "info" | "suggestion" | "warning";
  amount?: Money;
};

export type BudgetTurn = {
  kind: "budget";
  id: string;
  category: string;
  period: string;
  budget: Money;
  spent: Money;
  ratio: number;
};

export type Turn =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | ToolTurn
  | ApprovalTurn
  | InsightTurn
  | BudgetTurn;

export function toTranscript(events: AgentEvent[]): { turns: Turn[]; running: boolean } {
  const turns: Turn[] = [];
  const toolsById = new Map<string, ToolTurn>();
  const approvalsById = new Map<string, ApprovalTurn>();
  let assistant: { kind: "assistant"; id: string; text: string } | null = null;
  let openWorkflows = 0;

  for (const ev of events) {
    switch (ev.type) {
      case EventType.WorkflowStarted:
        openWorkflows++;
        assistant = null;
        turns.push({ kind: "user", id: ev.id, text: ev.input });
        break;

      case EventType.ModelDelta:
        if (!assistant) {
          assistant = { kind: "assistant", id: ev.id, text: "" };
          turns.push(assistant);
        }
        assistant.text += ev.text;
        break;

      case EventType.ModelCompleted:
        if (assistant) {
          // Live path: deltas already filled the bubble — just close it.
          assistant = null;
        } else if (ev.text) {
          // Replay path: deltas aren't persisted, so render the final text
          // carried by ModelCompleted itself.
          turns.push({ kind: "assistant", id: ev.id, text: ev.text });
        }
        break;

      case EventType.ToolRequested: {
        // A tool call ends the current text bubble and starts a tool card.
        assistant = null;
        const tool: ToolTurn = {
          kind: "tool",
          id: ev.id,
          toolCallId: ev.toolCallId,
          name: ev.name,
          args: ev.args,
          state: "running",
        };
        toolsById.set(ev.toolCallId, tool);
        turns.push(tool);
        break;
      }

      case EventType.ToolCompleted: {
        const tool = toolsById.get(ev.toolCallId);
        if (tool) {
          tool.state = "done";
          tool.result = ev.result;
        }
        break;
      }

      case EventType.ToolFailed: {
        const tool = toolsById.get(ev.toolCallId);
        if (tool) {
          tool.state = "failed";
          tool.error = ev.error;
        }
        break;
      }

      case EventType.ApprovalRequested: {
        // The loop is now paused. Close any open text bubble and show a card
        // the user can act on.
        assistant = null;
        const approval: ApprovalTurn = {
          kind: "approval",
          id: ev.id,
          approvalId: ev.approvalId,
          action: ev.action,
          summary: ev.summary,
          amount: ev.amount,
          details: ev.details,
          state: "pending",
        };
        approvalsById.set(ev.approvalId, approval);
        turns.push(approval);
        break;
      }

      case EventType.ApprovalGranted: {
        const approval = approvalsById.get(ev.approvalId);
        if (approval) {
          approval.state = "granted";
          approval.note = ev.note;
        }
        break;
      }

      case EventType.ApprovalDenied: {
        const approval = approvalsById.get(ev.approvalId);
        if (approval) {
          approval.state = "denied";
          approval.note = ev.reason;
        }
        break;
      }

      case EventType.InsightGenerated:
        turns.push({
          kind: "insight",
          id: ev.id,
          title: ev.title,
          detail: ev.detail,
          severity: ev.severity,
          amount: ev.amount,
        });
        break;

      case EventType.BudgetAlert:
        turns.push({
          kind: "budget",
          id: ev.id,
          category: ev.category,
          period: ev.period,
          budget: ev.budget,
          spent: ev.spent,
          ratio: ev.ratio,
        });
        break;

      case EventType.WorkflowCompleted:
      case EventType.WorkflowFailed:
        openWorkflows = Math.max(0, openWorkflows - 1);
        assistant = null;
        break;
    }
  }

  return { turns, running: openWorkflows > 0 };
}

// Money is integer cents — format it as a plain currency string for display.
export function formatMoney(m: Money): string {
  const value = (m.amountCents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${value} ${m.currency}`;
}

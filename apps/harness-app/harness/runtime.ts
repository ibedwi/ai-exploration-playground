import type { ModelMessage } from "ai";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { EventType, type Money } from "@shared/events";
import { emit } from "./bus";
import { streamModelTurn, type SimpleToolCall, type ModelTurnResult } from "./model";
import { runTool, MONEY_MOVING_TOOLS } from "./tools";
import { financeAgent } from "./agents";

const MAX_STEPS = 10;
const APPROVAL_TIMEOUT_S = 86_400; // a human approval is an unbounded wait — up to a day

// The browser's answer to an approval, delivered via DBOS.send (see server).
type ApprovalDecision = { decision: "approve" | "deny"; note?: string };

// Build the model's context from scratch each step: system prompt, the pinned
// task, then every turn so far verbatim.
function buildContext(task: string, turns: ModelMessage[][]): ModelMessage[] {
  return [
    { role: "system", content: financeAgent.systemPrompt },
    { role: "user", content: task },
    ...turns.flat(),
  ];
}

// Turn a tool's result into the `tool` message the model expects next turn.
function toolResultMessage(call: SimpleToolCall, value: unknown): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "json", value: value as never },
      },
    ],
  };
}

// A money-moving call → the human-readable summary + amount the confirm card shows.
function describeApproval(call: SimpleToolCall): { summary: string; amount?: Money } {
  const a = call.input;
  const amount =
    typeof a.amountCents === "number"
      ? { amountCents: a.amountCents, currency: String(a.currency ?? "USD") }
      : undefined;
  const money = amount ? `${(amount.amountCents / 100).toFixed(2)} ${amount.currency}` : "funds";
  if (call.toolName === "transferFunds") {
    return { summary: `Transfer ${money} from ${a.fromAccountId} to ${a.toAccountId}`, amount };
  }
  if (call.toolName === "payBill") {
    return { summary: `Pay ${money} for ${a.billId} from ${a.fromAccountId}`, amount };
  }
  return { summary: `Run ${call.toolName}`, amount };
}

// Translate certain tool RESULTS into first-class finance events, so the UI can
// render insight/alert cards instead of decoding raw tool JSON.
async function emitDomainEvents(
  workflowId: string,
  call: SimpleToolCall,
  result: Record<string, unknown>,
): Promise<void> {
  if (call.toolName === "getBudgets" && Array.isArray(result.budgets)) {
    for (const b of result.budgets as Array<Record<string, unknown>>) {
      const ratio = Number(b.ratio);
      if (ratio >= 0.9) {
        const currency = String(b.currency ?? "USD");
        await emit({
          type: EventType.BudgetAlert,
          workflowId,
          category: String(b.category),
          period: String(b.period),
          budget: { amountCents: Number(b.budgetCents), currency },
          spent: { amountCents: Number(b.spentCents), currency },
          ratio,
        });
      }
    }
  }
  if (call.toolName === "recordInsight" && result.insight) {
    const i = result.insight as Record<string, unknown>;
    await emit({
      type: EventType.InsightGenerated,
      workflowId,
      title: String(i.title),
      detail: String(i.detail),
      severity: (i.severity as "info" | "suggestion" | "warning") ?? "info",
      amount: i.amount as Money | undefined,
    });
  }
}

// Gate a money-moving call behind human approval. Emits ApprovalRequested, then
// SUSPENDS the durable workflow on DBOS.recv until the browser answers — which
// can be minutes or days, and survives a process restart. Returns whether to
// proceed. The approvalId is the toolCallId so it's stable across replay.
async function gate(
  workflowId: string,
  call: SimpleToolCall,
): Promise<{ approved: boolean; reason?: string }> {
  const approvalId = call.toolCallId;
  const { summary, amount } = describeApproval(call);

  await DBOS.runStep(
    () =>
      emit({
        type: EventType.ApprovalRequested,
        workflowId,
        approvalId,
        toolCallId: call.toolCallId,
        action: call.toolName,
        summary,
        amount,
        details: call.input,
      }),
    { name: `approval-req-${approvalId}` },
  );

  // Suspend here. recv wakes on DBOS.send(workflowId, decision, approvalId).
  const answer = await DBOS.recv<ApprovalDecision>(approvalId, APPROVAL_TIMEOUT_S);
  const decision = answer?.decision ?? "deny";

  if (decision === "approve") {
    await DBOS.runStep(
      () => emit({ type: EventType.ApprovalGranted, workflowId, approvalId, note: answer?.note }),
      { name: `approval-granted-${approvalId}` },
    );
    return { approved: true };
  }

  const reason = answer?.note ?? (answer ? "User denied the action." : "Approval timed out.");
  await DBOS.runStep(
    () => emit({ type: EventType.ApprovalDenied, workflowId, approvalId, reason }),
    { name: `approval-denied-${approvalId}` },
  );
  return { approved: false, reason };
}

// Run one tool as a durable step: emit request → execute → emit result + any
// domain events. Returns the JSON value fed back to the model (DBOS checkpoints
// it, so on recovery the tool isn't run twice).
async function runToolStep(
  workflowId: string,
  call: SimpleToolCall,
): Promise<{ value: unknown }> {
  await emit({
    type: EventType.ToolRequested,
    workflowId,
    toolCallId: call.toolCallId,
    name: call.toolName,
    args: call.input,
  });
  try {
    const output = await runTool(call.toolName, call.input);
    await emit({ type: EventType.ToolCompleted, workflowId, toolCallId: call.toolCallId, result: output });
    await emitDomainEvents(workflowId, call, output);
    return { value: output };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await emit({ type: EventType.ToolFailed, workflowId, toolCallId: call.toolCallId, error });
    return { value: { error } };
  }
}

// THE DURABLE AGENT LOOP.
//
// Same loop as before, but each side effect is a named DBOS step and the whole
// thing is a registered workflow. On a crash, DBOS replays completed steps from
// their checkpoints and resumes at the first unfinished one — the model isn't
// re-prompted, tools aren't re-run, and a pending approval survives a restart.
async function agentWorkflow(input: string): Promise<string> {
  const workflowId = DBOS.workflowID ?? "unknown";
  await DBOS.runStep(() => emit({ type: EventType.WorkflowStarted, workflowId, input }), {
    name: "started",
  });

  const turns: ModelMessage[][] = [];

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const context = buildContext(input, turns);

      // The model turn is one step: it streams deltas (live) and returns the
      // text + tool calls, which DBOS checkpoints.
      const turn: ModelTurnResult = await DBOS.runStep(
        () =>
          streamModelTurn({
            messages: context,
            tools: financeAgent.tools,
            onDelta: (text) => {
              void emit({ type: EventType.ModelDelta, workflowId, text });
            },
          }),
        { name: `model-${step}` },
      );

      const turnMessages: ModelMessage[] = [...turn.responseMessages];

      // No tool calls => final answer. We're done.
      if (turn.toolCalls.length === 0) {
        await DBOS.runStep(
          () => emit({ type: EventType.ModelCompleted, workflowId, text: turn.text }),
          { name: `model-done-${step}` },
        );
        await DBOS.runStep(
          () => emit({ type: EventType.WorkflowCompleted, workflowId, output: turn.text }),
          { name: "completed" },
        );
        return turn.text;
      }

      for (const call of turn.toolCalls) {
        // Money-moving? Pause for human approval before doing anything.
        if (MONEY_MOVING_TOOLS.has(call.toolName)) {
          const { approved, reason } = await gate(workflowId, call);
          if (!approved) {
            turnMessages.push(toolResultMessage(call, { denied: true, reason }));
            continue;
          }
        }

        const outcome = await DBOS.runStep(() => runToolStep(workflowId, call), {
          name: `tool-${call.toolCallId}`,
        });
        turnMessages.push(toolResultMessage(call, outcome.value));
      }

      turns.push(turnMessages);
    }

    await DBOS.runStep(
      () =>
        emit({
          type: EventType.WorkflowFailed,
          workflowId,
          error: `Hit the ${MAX_STEPS}-step limit without finishing.`,
        }),
      { name: "failed" },
    );
    return "";
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await DBOS.runStep(() => emit({ type: EventType.WorkflowFailed, workflowId, error }), {
      name: "failed-exception",
    });
    return "";
  }
}

export const runAgentWorkflow = DBOS.registerWorkflow(agentWorkflow, { name: "agentWorkflow" });

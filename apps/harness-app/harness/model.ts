import { streamText, type ModelMessage, type ToolSet } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

// The one place the model is configured.
//
// If ANTHROPIC_API_KEY is set we use a real Claude model through the Vercel AI
// SDK. If it is NOT set we fall back to a built-in MOCK so the whole app runs
// end-to-end with zero setup — great for seeing the harness work before you add
// a key. The provider reads the key from the environment at request time.

const apiKey = process.env.ANTHROPIC_API_KEY;
export const MODEL_NAME = process.env.MODEL ?? "claude-sonnet-4-6";
export const usingMock = !apiKey;

const model = apiKey ? createAnthropic({ apiKey })(MODEL_NAME) : null;

// A model turn, abstracted so the runtime doesn't care real vs. mock.
export type SimpleToolCall = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};
export type ModelTurnResult = {
  text: string;
  toolCalls: SimpleToolCall[];
  // Messages to append to the running context (assistant text + tool calls).
  responseMessages: ModelMessage[];
};

// Run ONE model turn over the given context with the given tools.
// Streams text deltas out through `onDelta` as they arrive.
export async function streamModelTurn(opts: {
  messages: ModelMessage[];
  tools: ToolSet;
  onDelta: (text: string) => void;
}): Promise<ModelTurnResult> {
  if (!model) return mockTurn(opts);

  const result = streamText({ model, messages: opts.messages, tools: opts.tools });

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") opts.onDelta(part.text);
  }

  return {
    text: await result.text,
    toolCalls: (await result.toolCalls).map((c) => ({
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.input as Record<string, unknown>,
    })),
    responseMessages: (await result.response).messages,
  };
}

// ── The mock model ───────────────────────────────────────────────────────────
//
// A tiny deterministic "agent" that walks the finance loop with no API key:
//   step 0: pull budgets          (a read tool -> a BudgetAlert domain event)
//   step 1: move $200 to savings  (a MONEY-MOVING tool -> the approval gate)
//   step 2: answer.
// Enough to exercise streaming, a read tool, a domain event, the human-approval
// pause, and completion end-to-end.
let mockCallCounter = 0;

// Build a one-tool-call turn (assistant text + the tool-call part).
function mockToolTurn(text: string, toolName: string, input: Record<string, unknown>): ModelTurnResult {
  const toolCallId = `mock-${++mockCallCounter}`;
  return {
    text,
    toolCalls: [{ toolCallId, toolName, input }],
    responseMessages: [
      {
        role: "assistant",
        content: [
          { type: "text", text },
          { type: "tool-call", toolCallId, toolName, input },
        ],
      },
    ],
  };
}

async function mockTurn(opts: {
  messages: ModelMessage[];
  tools: ToolSet;
  onDelta: (text: string) => void;
}): Promise<ModelTurnResult> {
  // How many tool results are already in the context? That's our "step".
  const toolResults = opts.messages.filter((m) => m.role === "tool").length;

  if (toolResults === 0 && "getBudgets" in opts.tools) {
    const text = "Let me check your budgets for this month.";
    await stream(opts.onDelta, text);
    return mockToolTurn(text, "getBudgets", { period: "2026-09" });
  }

  if (toolResults === 1 && "transferFunds" in opts.tools) {
    const text = "You're over on Dining — I'll move $200 to savings to stay on track.";
    await stream(opts.onDelta, text);
    return mockToolTurn(text, "transferFunds", {
      fromAccountId: "acc_checking",
      toAccountId: "acc_savings",
      amountCents: 20000,
      currency: "USD",
    });
  }

  // Step 2 (or later): wrap up, referencing what happened.
  const answer =
    `Done. I reviewed your September budgets and proposed a $200 transfer to savings. ` +
    `(This reply came from the built-in mock model — set ANTHROPIC_API_KEY to use a real Claude model.)`;
  await stream(opts.onDelta, answer);
  return {
    text: answer,
    toolCalls: [],
    responseMessages: [{ role: "assistant", content: [{ type: "text", text: answer }] }],
  };
}

// Emit a string word-by-word so the UI shows real streaming.
async function stream(onDelta: (t: string) => void, text: string): Promise<void> {
  for (const word of text.split(" ")) {
    onDelta(word + " ");
    await new Promise((r) => setTimeout(r, 15));
  }
}

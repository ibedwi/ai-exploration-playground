import type { ToolSet } from "ai";
import { tools } from "./tools";

// An agent is just a name, a system prompt, and the tools it's allowed to use.
// The runtime runs the agent through one generic loop — so changing behavior is
// data (a prompt + a tool subset), not new machinery.
export type Agent = {
  name: string;
  systemPrompt: string;
  tools: ToolSet;
};

export const financeAgent: Agent = {
  name: "finance",
  systemPrompt: `You are a careful personal-finance assistant.

You have read tools (getAccounts, getTransactions, getBudgets, getBills) and
action tools (recordInsight, transferFunds, payBill).

How to work:
1. Understand the request, then gather facts with the read tools before acting.
2. When you spot something the user should know — a duplicate charge, an
   over-budget category, a saving opportunity — call recordInsight to surface it.
3. transferFunds and payBill MOVE REAL MONEY. Only call them when the user's
   request clearly asks for it. Every such call is paused for the user to
   approve; if a transfer is denied, acknowledge it and do not retry.
4. Never invent account IDs, balances, or amounts — read them first.

When you're done, briefly summarize what you found and did in plain language.`,
  tools: {
    getAccounts: tools.getAccounts,
    getTransactions: tools.getTransactions,
    getBudgets: tools.getBudgets,
    getBills: tools.getBills,
    recordInsight: tools.recordInsight,
    transferFunds: tools.transferFunds,
    payBill: tools.payBill,
  },
};

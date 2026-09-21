import { tool } from "ai";
import { z } from "zod";

// ── Canned data the read tools serve ────────────────────────────────────────
//
// A tiny fake personal-finance backend. All money is integer cents.

type Account = { id: string; name: string; type: "checking" | "savings" | "credit"; balanceCents: number; currency: string };
type Transaction = { id: string; accountId: string; amountCents: number; date: string; merchant: string; category: string };
type Bill = { id: string; payee: string; amountCents: number; dueDate: string; currency: string; status: "due" | "paid" };
type Budget = { category: string; period: string; budgetCents: number; spentCents: number; currency: string };

const ACCOUNTS: Account[] = [
  { id: "acc_checking", name: "Everyday Checking", type: "checking", balanceCents: 320000, currency: "USD" },
  { id: "acc_savings", name: "Rainy Day Savings", type: "savings", balanceCents: 1500000, currency: "USD" },
  { id: "acc_credit", name: "Rewards Card", type: "credit", balanceCents: -45000, currency: "USD" },
];

// Note the planted duplicate: txn_004 and txn_005 are the same Streamflix
// charge on the same day — the kind of thing the agent should flag as an insight.
const TRANSACTIONS: Transaction[] = [
  { id: "txn_001", accountId: "acc_checking", amountCents: 480000, date: "2026-09-01", merchant: "Acme Payroll", category: "Income" },
  { id: "txn_002", accountId: "acc_checking", amountCents: -6200, date: "2026-09-03", merchant: "Blue Bottle", category: "Dining" },
  { id: "txn_003", accountId: "acc_checking", amountCents: -8300, date: "2026-09-05", merchant: "The Corner Bistro", category: "Dining" },
  { id: "txn_004", accountId: "acc_checking", amountCents: -1599, date: "2026-09-07", merchant: "Streamflix", category: "Entertainment" },
  { id: "txn_005", accountId: "acc_checking", amountCents: -1599, date: "2026-09-07", merchant: "Streamflix", category: "Entertainment" },
  { id: "txn_006", accountId: "acc_checking", amountCents: -21400, date: "2026-09-10", merchant: "Whole Foods", category: "Groceries" },
  { id: "txn_007", accountId: "acc_checking", amountCents: -9800, date: "2026-09-14", merchant: "Sushi Nakamura", category: "Dining" },
];

const BILLS: Bill[] = [
  { id: "bill_electric", payee: "City Power & Light", amountCents: 12400, dueDate: "2026-09-25", currency: "USD", status: "due" },
  { id: "bill_internet", payee: "FiberNet", amountCents: 7000, dueDate: "2026-09-28", currency: "USD", status: "due" },
];

const BUDGETS: Budget[] = [
  { category: "Dining", period: "2026-09", budgetCents: 30000, spentCents: 41500, currency: "USD" },
  { category: "Groceries", period: "2026-09", budgetCents: 60000, spentCents: 42000, currency: "USD" },
  { category: "Entertainment", period: "2026-09", budgetCents: 10000, spentCents: 9500, currency: "USD" },
];

// ── Money-moving tools ───────────────────────────────────────────────────────
//
// The runtime gates every tool named here behind a human approval before it
// runs. Keeping it as a plain Set means "make this action require confirmation"
// is one line, not new machinery.
export const MONEY_MOVING_TOOLS = new Set<string>(["transferFunds", "payBill"]);

// ── The tool SCHEMAS the model sees ─────────────────────────────────────────
//
// These declare the shape of each tool. We deliberately DON'T give them an
// `execute` — the model returns tool calls to the harness, which runs them
// itself (see runTool). That keeps every side effect visible as an event, and
// lets the harness slip an approval gate in front of the risky ones.

export const tools = {
  getAccounts: tool({
    description: "List the user's accounts with balances. Returns [{ id, name, type, balanceCents, currency }].",
    inputSchema: z.object({}),
  }),
  getTransactions: tool({
    description: "List recent transactions, newest first. Negative amountCents are debits (money out).",
    inputSchema: z.object({
      accountId: z.string().optional(),
      limit: z.number().int().positive().optional(),
    }),
  }),
  getBudgets: tool({
    description: "Get budgets vs. actual spend for a period (YYYY-MM). Omit period for the current month.",
    inputSchema: z.object({ period: z.string().optional() }),
  }),
  getBills: tool({
    description: "List upcoming/unpaid bills. Returns [{ id, payee, amountCents, dueDate, status }].",
    inputSchema: z.object({}),
  }),
  recordInsight: tool({
    description:
      "Surface a finance insight to the user (e.g. a duplicate charge or a saving opportunity). Does not move money.",
    inputSchema: z.object({
      title: z.string(),
      detail: z.string(),
      severity: z.enum(["info", "suggestion", "warning"]),
      amountCents: z.number().int().optional(),
      currency: z.string().optional(),
    }),
  }),
  transferFunds: tool({
    description: "Transfer money between two of the user's accounts. MONEY-MOVING: requires user approval.",
    inputSchema: z.object({
      fromAccountId: z.string(),
      toAccountId: z.string(),
      amountCents: z.number().int().positive(),
      currency: z.string(),
    }),
  }),
  payBill: tool({
    description: "Pay a bill from an account. MONEY-MOVING: requires user approval.",
    inputSchema: z.object({
      billId: z.string(),
      fromAccountId: z.string(),
      amountCents: z.number().int().positive(),
      currency: z.string(),
    }),
  }),
};

// ── The harness-owned executor ──────────────────────────────────────────────
//
// Where tool calls actually run. Each case returns a JSON-serializable result
// that gets fed back to the model and emitted as a ToolCompleted event. The
// runtime translates some of these results into domain events (budget alerts,
// insights) — see runtime.ts.
export async function runTool(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (name) {
    case "getAccounts":
      return { accounts: ACCOUNTS };

    case "getTransactions": {
      const accountId = args.accountId ? String(args.accountId) : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      let txns = accountId ? TRANSACTIONS.filter((t) => t.accountId === accountId) : TRANSACTIONS;
      txns = [...txns].sort((a, b) => b.date.localeCompare(a.date));
      if (limit) txns = txns.slice(0, limit);
      return { transactions: txns };
    }

    case "getBudgets": {
      const period = args.period ? String(args.period) : "2026-09";
      const budgets = BUDGETS.filter((b) => b.period === period).map((b) => ({
        ...b,
        ratio: Number((b.spentCents / b.budgetCents).toFixed(3)),
      }));
      return { period, budgets };
    }

    case "getBills":
      return { bills: BILLS.filter((b) => b.status === "due") };

    case "recordInsight":
      // The runtime reads `insight` off this result and emits InsightGenerated.
      return {
        ok: true,
        insight: {
          title: String(args.title ?? ""),
          detail: String(args.detail ?? ""),
          severity: (args.severity as string) ?? "info",
          amount:
            typeof args.amountCents === "number"
              ? { amountCents: args.amountCents, currency: String(args.currency ?? "USD") }
              : undefined,
        },
      };

    case "transferFunds":
      return {
        ok: true,
        transferId: `xfer-${Date.now()}`,
        fromAccountId: args.fromAccountId,
        toAccountId: args.toAccountId,
        amountCents: args.amountCents,
        currency: args.currency,
      };

    case "payBill":
      return {
        ok: true,
        paymentId: `pay-${Date.now()}`,
        billId: args.billId,
        amountCents: args.amountCents,
        currency: args.currency,
      };

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

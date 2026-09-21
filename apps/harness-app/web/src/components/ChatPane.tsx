import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, ClientMessage } from "@shared/events";
import { toTranscript, formatMoney, type Turn } from "../transcript";

// The left pane: a chat view derived entirely from the event stream, plus an
// input to submit a new task.
export function ChatPane({
  events,
  send,
}: {
  events: AgentEvent[];
  send: (m: ClientMessage) => void;
}) {
  const { turns, running } = useMemo(() => toTranscript(events), [events]);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns.length, running]);

  function submit() {
    const text = input.trim();
    if (!text) return;
    send({ type: "submit_task", input: text });
    setInput("");
  }

  return (
    <section className="pane">
      <div className="pane-header">Chat</div>
      <div className="chat-scroll">
        {turns.length === 0 && (
          <div className="empty">
            Ask your finance assistant something. Try:
            <br />
            <em>"I'm over budget on dining this month — can you move $200 to savings?"</em>
          </div>
        )}
        {turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} send={send} />
        ))}
        {running && <div className="typing">agent is working…</div>}
        <div ref={bottomRef} />
      </div>
      <div className="composer">
        <textarea
          value={input}
          placeholder="Message the agent…  (Enter to send, Shift+Enter for newline)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
        />
        <button onClick={submit} disabled={!input.trim()}>
          Send
        </button>
      </div>
    </section>
  );
}

function TurnView({ turn, send }: { turn: Turn; send: (m: ClientMessage) => void }) {
  if (turn.kind === "user") {
    return (
      <div className="msg user">
        <div className="bubble">{turn.text}</div>
      </div>
    );
  }
  if (turn.kind === "assistant") {
    return (
      <div className="msg assistant">
        <div className="bubble">{turn.text || "…"}</div>
      </div>
    );
  }
  if (turn.kind === "approval") {
    return <ApprovalCard turn={turn} send={send} />;
  }
  if (turn.kind === "insight") {
    return (
      <div className="msg card">
        <div className={`insight-card ${turn.severity}`}>
          <div className="insight-head">
            <span className="insight-icon">💡</span>
            <span className="insight-title">{turn.title}</span>
            {turn.amount && <span className="insight-amount">{formatMoney(turn.amount)}</span>}
          </div>
          <div className="insight-detail">{turn.detail}</div>
        </div>
      </div>
    );
  }
  if (turn.kind === "budget") {
    const pct = Math.round(turn.ratio * 100);
    const over = turn.ratio >= 1;
    return (
      <div className="msg card">
        <div className={`budget-card ${over ? "over" : "near"}`}>
          <div className="budget-head">
            <span>
              {over ? "⚠️" : "📊"} {turn.category}
            </span>
            <span className="budget-period">{turn.period}</span>
          </div>
          <div className="budget-bar">
            <div className="budget-fill" style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          <div className="budget-figures">
            {formatMoney(turn.spent)} of {formatMoney(turn.budget)} ({pct}%)
          </div>
        </div>
      </div>
    );
  }
  // tool card
  return (
    <div className="msg tool">
      <div className={`tool-card ${turn.state}`}>
        <div className="tool-head">
          <span className="tool-name">🔧 {turn.name}</span>
          <span className="tool-state">{turn.state}</span>
        </div>
        <pre className="tool-args">{JSON.stringify(turn.args, null, 2)}</pre>
        {turn.result !== undefined && (
          <pre className="tool-result">{JSON.stringify(turn.result, null, 2)}</pre>
        )}
        {turn.error && <pre className="tool-error">{turn.error}</pre>}
      </div>
    </div>
  );
}

// The human-in-the-loop card. While pending, it offers Approve / Deny, which
// send a `submit_approval` back over the socket to unblock the paused loop.
// Once answered, it just shows the outcome (derived from the events).
function ApprovalCard({
  turn,
  send,
}: {
  turn: Extract<Turn, { kind: "approval" }>;
  send: (m: ClientMessage) => void;
}) {
  const pending = turn.state === "pending";
  return (
    <div className="msg card">
      <div className={`approval-card ${turn.state}`}>
        <div className="approval-head">
          <span className="approval-badge">approval required</span>
          <span className="approval-action">{turn.action}</span>
        </div>
        <div className="approval-summary">
          {turn.summary}
          {turn.amount && <strong className="approval-amount"> · {formatMoney(turn.amount)}</strong>}
        </div>
        {pending ? (
          <div className="approval-actions">
            <button
              className="approve"
              onClick={() => send({ type: "submit_approval", approvalId: turn.approvalId, decision: "approve" })}
            >
              Approve
            </button>
            <button
              className="deny"
              onClick={() => send({ type: "submit_approval", approvalId: turn.approvalId, decision: "deny" })}
            >
              Deny
            </button>
          </div>
        ) : (
          <div className={`approval-outcome ${turn.state}`}>
            {turn.state === "granted" ? "✓ Approved" : "✕ Denied"}
            {turn.note ? ` — ${turn.note}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}

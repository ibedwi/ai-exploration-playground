import { useEffect, useRef } from "react";
import { EventType, type AgentEvent } from "@shared/events";

// The right pane: the raw event timeline. This is the "harness" seen honestly —
// every single thing the system did, in order, exactly as it crossed the wire.
export function InspectorPane({
  events,
  onClear,
}: {
  events: AgentEvent[];
  onClear: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  return (
    <section className="pane">
      <div className="pane-header">
        <span>Event stream</span>
        <button className="clear-btn" onClick={onClear}>
          clear
        </button>
      </div>
      <div className="events-scroll">
        {events.length === 0 && <div className="empty">No events yet.</div>}
        {events.map((ev) => (
          <div key={ev.id} className={`event ${eventClass(ev.type)}`}>
            <span className="event-type">{ev.type}</span>
            <span className="event-detail">{summarize(ev)}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}

function eventClass(type: EventType): string {
  if (type.startsWith("workflow")) return "ev-workflow";
  if (type.startsWith("model")) return "ev-model";
  if (type.startsWith("tool")) return "ev-tool";
  if (type.startsWith("approval")) return "ev-approval";
  if (type.startsWith("insight")) return "ev-insight";
  if (type.startsWith("budget")) return "ev-budget";
  return "ev-log";
}

function summarize(ev: AgentEvent): string {
  switch (ev.type) {
    case EventType.WorkflowStarted:
      return ev.input;
    case EventType.WorkflowCompleted:
      return ev.output;
    case EventType.WorkflowFailed:
      return ev.error;
    case EventType.ModelDelta:
      return JSON.stringify(ev.text);
    case EventType.ModelCompleted:
      return ev.text;
    case EventType.ToolRequested:
      return `${ev.name}(${JSON.stringify(ev.args)})`;
    case EventType.ToolCompleted:
      return JSON.stringify(ev.result);
    case EventType.ToolFailed:
      return ev.error;
    case EventType.ApprovalRequested:
      return `${ev.action}: ${ev.summary}`;
    case EventType.ApprovalGranted:
      return ev.note ? `granted — ${ev.note}` : "granted";
    case EventType.ApprovalDenied:
      return ev.reason ? `denied — ${ev.reason}` : "denied";
    case EventType.InsightGenerated:
      return `[${ev.severity}] ${ev.title}`;
    case EventType.BudgetAlert:
      return `${ev.category} ${ev.period}: ${ev.spent.amountCents / 100}/${ev.budget.amountCents / 100} (${Math.round(ev.ratio * 100)}%)`;
    case EventType.Log:
      return ev.message;
    default:
      return "";
  }
}

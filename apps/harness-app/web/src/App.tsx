import { useHarnessSocket } from "./useHarnessSocket";
import { ChatPane } from "./components/ChatPane";
import { InspectorPane } from "./components/InspectorPane";

export function App() {
  const { events, connected, send, clear } = useHarnessSocket();

  return (
    <div className="app">
      <header className="topbar">
        <span className="title">
          Harness <span className="muted">Inspector</span>
        </span>
        <span className={`status ${connected ? "on" : "off"}`}>
          <span className="dot" />
          {connected ? "connected" : "disconnected"}
        </span>
      </header>
      <main className="grid">
        <ChatPane events={events} send={send} />
        <InspectorPane events={events} onClear={clear} />
      </main>
    </div>
  );
}

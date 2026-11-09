import "../src/styles.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../src/components/ChatView.tsx";
import { SettingsProvider, useSettings } from "../src/lib/settings.ts";
import { forgetWaitingSends, rememberWaitingSend, waitingKey } from "../src/lib/sentWaiting.ts";

declare global {
  interface Window {
    queuedSendQa: {
      seed(texts: string[]): void;
      refresh(): void;
      status(value: "working" | "idle"): void;
    };
  }
}

function Fixture() {
  const [refresh, setRefresh] = useState(0);
  const [status, setStatus] = useState<"working" | "idle">("working");
  const { update } = useSettings();
  useEffect(() => { update({ language: "ko" }); }, [update]);
  window.queuedSendQa = {
    seed: (texts) => {
      const key = waitingKey("local", "queue-pane");
      forgetWaitingSends(key);
      for (const text of texts) rememberWaitingSend(key, text);
    },
    refresh: () => setRefresh((value) => value + 1),
    status: setStatus,
  };
  return <div className="terminal-host"><div className="terminal-stack is-chat" style={{ position: "relative", height: "100vh" }}>
    <ChatView paneId="queue-pane" refreshKey={refresh} promptRefreshKey={refresh} connected ended={false} agent="codex" agentStatus={status} />
  </div></div>;
}

createRoot(document.getElementById("root")!).render(<SettingsProvider><Fixture /></SettingsProvider>);

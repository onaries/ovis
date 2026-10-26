import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { ChatView } from "../src/components/ChatView.tsx";
import { SettingsProvider } from "../src/lib/settings.ts";
declare global { interface Window { chatFallbackQA: { pane: (pane: string) => void; refresh: () => void; agent: (agent: string | null) => void } } }
function Fixture() {
  const [agent, setAgent] = useState<string | null>("codex");
  const [pane, setPane] = useState("agent");
  const [refresh, setRefresh] = useState(0);
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  window.chatFallbackQA = { pane: setPane, agent: setAgent, refresh: () => setRefresh((key) => key + 1) };
  return <main style={{ height: "100vh", display: "flex", flexDirection: "column" }}><div style={{ position: "relative", flex: 1, minHeight: 0 }}><ChatView key={pane} paneId={pane} refreshKey={refresh} promptRefreshKey={refresh} promptDock={dock} connected ended={false} agent={pane === "shell" ? null : agent} conversationPushes={new URLSearchParams(location.search).has("pushes")} /></div><div ref={setDock} /></main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><SettingsProvider><Fixture /></SettingsProvider></React.StrictMode>);

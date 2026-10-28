import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../src/components/ChatView.tsx";
import { SettingsProvider } from "../src/lib/settings.ts";
import "../src/styles.css";

function Fixture() {
  const [pane, setPane] = useState("capacity");
  const [terminal, setTerminal] = useState(false);
  const [retries, setRetries] = useState(0);
  return <SettingsProvider><button onClick={() => setPane(pane === "capacity" ? "other" : "capacity")}>Switch pane</button>
    <output>{terminal ? "Terminal opened" : "Terminal closed"}</output>
    <output id="capacity-retries">{retries}</output>
    <div style={{ position: "relative", height: "calc(100dvh - 50px)" }}><ChatView paneId={pane} agent="codex" agentStatus="working" connected={true} ended={false} refreshKey={0} interactive onCapacityRetry={async () => { setRetries((value) => value + 1); return true; }} onOpenTerminal={() => setTerminal(true)} /></div>
  </SettingsProvider>;
}
const root = document.getElementById("root");
if (root === null) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);

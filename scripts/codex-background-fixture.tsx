import "../src/styles.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../src/components/Composer.tsx";
import { SettingsProvider } from "../src/lib/settings.ts";

declare global { interface Window { codexBackgroundQA: { count: (value: number) => void; pane: (value: string) => void } } }
function Fixture() {
  const [count, setCount] = useState(0);
  const [pane, setPane] = useState("parent");
  window.codexBackgroundQA = { count: setCount, pane: setPane };
  return <div className="terminal-host" style={{ height: "100dvh", display: "flex", flexDirection: "column", justifyContent: "end" }}>
    <Composer key={pane} paneId={pane} connected agent="codex" agentStatus="working" backgroundTasks={count} autoFocus={false}
      onSend={() => { throw new Error("The test must not send input"); }} onAbort={() => { throw new Error("The test must not stop an agent"); }}
      onUploadImage={async () => { throw new Error("The test must not upload files"); }} />
  </div>;
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<SettingsProvider><Fixture /></SettingsProvider>);

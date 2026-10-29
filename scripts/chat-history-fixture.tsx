/** Browser-only regression fixture, bundled by chat-history-browser-qa.ts. */
import React, { Profiler, useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsProvider, useSettings } from "../src/lib/settings.ts";
import { PaneTerminal } from "../src/components/PaneTerminal.tsx";
import { ChatView } from "../src/components/ChatView.tsx";
import { useWholeOutput } from "../src/lib/useWholeOutput.ts";
import { MachineContext } from "../src/lib/machineContext.tsx";
import { useUpdates } from "../src/lib/updates.ts";
import { UpdateNotice } from "../src/components/UpdateControls.tsx";
import "../src/styles.css";

declare global { interface Window { qa: { requests: { url: string; signal: AbortSignal; resolve: (text: string) => void; reject: () => void }[]; commits: string[][]; answered: string[]; target: (url: string, scope: string) => void; chat: (pane: string, machine?: string) => void; view: (chat: boolean) => void; agent: (agent: string | null) => void; select: (pane: string, machine: string, agent?: string) => void; refresh: () => void; historyPrompts: (prompts: number) => void } } }
const nativeFetch = window.fetch;
window.qa = { requests: [], commits: [], answered: [], target: () => {}, chat: () => {}, view: () => {}, agent: () => {}, select: () => {}, refresh: () => {}, historyPrompts: () => {} };
window.fetch = (input, init) => {
  const url = String(input);
  if (!url.includes("tool-output") && !url.startsWith("/qa-output")) {
    const answer = nativeFetch(input, init);
    // "machine/pane" of every conversation request that ended, answered or cancelled: the
    // script waits on it before it says a late answer changed nothing
    if (url.includes("/conversation?")) {
      const parsed = new URL(url, location.href);
      const key = `${/\/api\/machines\/([^/]+)\//.exec(parsed.pathname)?.[1] ?? "local"}/${parsed.searchParams.get("pane_id")}`;
      const ended = () => { window.qa.answered.push(key); };
      answer.then(ended, ended);
    }
    return answer;
  }
  // Deliberately ignores cancellation: late transports must still be harmless.
  return new Promise((resolve, reject) => window.qa.requests.push({ url, signal: init!.signal as AbortSignal,
    resolve: (text) => resolve(new Response(text)), reject: () => reject(new Error("late failure")) }));
};
/** The app's update line as App mounts it, without a server to poll: math-browser-qa.ts reads its reload line. */
function UpdatesLine() {
  return <UpdateNotice updates={useUpdates(false)} onOpen={() => {}} />;
}
function Fixture() {
  const [target, setTarget] = useState({ url: "/qa-output?pane=a&ref=x", scope: "one" });
  const [pane, setPane] = useState("a");
  const [machine, setMachine] = useState("local");
  const [refresh, setRefresh] = useState(0);
  const [agent, setAgent] = useState<string | null>("omo");
  window.qa.agent = setAgent;
  const output = useWholeOutput(target.url, target.scope);
  const { update } = useSettings();
  // Settings, Chat, History page size: changed while the chat stays mounted
  window.qa.historyPrompts = (historyPrompts) => update({ historyPrompts });
  window.qa.target = (url, scope) => setTarget({ url, scope });
  window.qa.chat = (pane, machine = "local") => { setPane(pane); setMachine(machine); };
  window.qa.refresh = () => setRefresh((value) => value + 1);
  return <><UpdatesLine /><button id="fetch-output" onClick={() => { output.load(); output.load(); }}>Load output</button><output id="output">{output.state}:{output.text}</output>
    {/* A visible split sibling must read and measure its chat without owning keyboard shortcuts. */}
    <div style={{ position: "relative", height: 600 }}><MachineContext.Provider value={machine}><ChatView key={machine} paneId={pane} active={false} refreshKey={refresh} connected={true} ended={false} agent={agent} agentStatus={null} /></MachineContext.Provider></div></>;
}
function Product({ pane, machine, agent }: { pane: string; machine: string; agent: string }) {
  const [chat, setChat] = useState(true);
  window.qa.view = setChat;
  return <div style={{ position: "relative", height: 600 }}><MachineContext.Provider value={machine}><Profiler id="product-pane" onRender={() => {
    window.qa.commits.push(Array.from(document.querySelectorAll(".chat-turn"), (turn) => turn.textContent ?? ""));
  }}><PaneTerminal key={machine} paneId={pane} agent={agent} view={chat ? "chat" : "terminal"} terminalFontSize={14} terminalWheelSpeed={1} terminalFontFamily="" theme="dark" palette="amber" /></Profiler></MachineContext.Provider></div>;
}
function Root() {
  const [selected, setSelected] = useState<{ pane: string; machine: string; agent: string } | null>(null);
  window.qa.select = (pane, machine, agent = "codex") => setSelected({ pane, machine, agent });
  // The hook and ChatView checks keep StrictMode. The real PaneTerminal is mounted outside it:
  // xterm's viewport callbacks can outlive StrictMode's synthetic terminal unmount.
  return selected ? <SettingsProvider><Product pane={selected.pane} machine={selected.machine} agent={selected.agent} /></SettingsProvider>
    : <React.StrictMode><SettingsProvider><Fixture /></SettingsProvider></React.StrictMode>;
}
createRoot(document.getElementById("root")!).render(<Root />);

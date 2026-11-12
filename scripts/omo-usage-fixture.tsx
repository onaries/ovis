import "../src/styles.css";
import { createRoot } from "react-dom/client";
import { Turn } from "../src/components/ChatView.tsx";
import { SettingsProvider } from "../src/lib/settings.ts";

const root = document.getElementById("root");
if (root) createRoot(root).render(<SettingsProvider>
  <main style={{ padding: "var(--space-3)", maxWidth: "800px" }}>
    <Turn paneId="fixture" rowKey="answer" live={false} waiting={false} showThinking={false} turn={{
      role: "assistant", ts: "2026-11-12T01:45:00Z", end_ts: "2026-11-12T01:45:05Z",
      parts: [{ kind: "text", text: "확인을 마쳤습니다. 답변에 사용한 입력과 출력 토큰, 캐시 적중률을 아래에서 확인할 수 있습니다." }],
      usage: { input: 25000, output: 3700, cache_read: 75000, cache_write: 0 },
    }} />
  </main>
</SettingsProvider>);

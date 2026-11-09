/**
 * Chinese for the settings keys of Settings → Appearance's agent rows: the rest of the settings part
 * (./settings.zh.ts), kept apart so each file stays short. All these files are the one settings
 * part, so a key lives in only one of them; ./settings.zh.ts's header lists the settings files and the register.
 */
export const SETTINGS_AGENTS_ZH: Record<string, string> = {
  "OpenCode: subagent ends from their session": "OpenCode：从父会话读取子代理结束",
  "An OpenCode subagent counts as running, and holds its turn's BG wait, until the session that started it is told it ended, not as soon as the subagent goes idle. Its own background work may still run then. When off, the subagent's own rows tell.": "OpenCode 子 Agent 不会在其空闲时立即视为结束，而是一直计为运行中，并保持该轮的 BG 等待，直到启动它的会话被告知它已结束。此时子 Agent 自己的后台任务可能仍在运行。关闭时，按子 Agent 自己的记录判断。",
  "OMP on macOS herdr-core: chat from the session it holds open": "OMP（macOS 上的 herdr-core）：从打开的会话读取聊天",
  "On a Mac running herdr-core, an OMP pane's chat comes from the session file its omp holds open, read with lsof, so omp -c and resumed sessions show their chat. When off, the chat there falls back to the terminal.": "在运行 herdr-core 的 Mac 上，OMP 窗格的聊天通过 lsof 从 omp 打开的会话文件读取，因此 omp -c 和恢复的会话也会显示聊天。关闭时，那里的聊天会退回终端。",
};

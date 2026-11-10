/**
 * Korean for the settings keys of Settings → Appearance's agent rows: the rest of the settings part
 * (./settings.ko.ts), kept apart so each file stays short. All these files are the one settings
 * part, so a key lives in only one of them; ./settings.ko.ts's header lists the settings files and the register.
 */
export const SETTINGS_AGENTS_KO: Record<string, string> = {
  "OpenCode: subagent ends from their session": "OpenCode 완료 확인을 상위 세션에서 받기",
  "An OpenCode subagent counts as running, and holds its turn's BG wait, until the session that started it is told it ended, not as soon as the subagent goes idle. Its own background work may still run then. When off, the subagent's own rows tell.": "OpenCode 하위 에이전트는 자기가 쉬는 상태가 되어도 바로 끝난 것으로 보지 않고, 그 에이전트를 시작한 세션이 끝났다고 전달받을 때까지 실행 중으로 세며 그 턴의 BG 대기도 유지합니다. 그때도 에이전트 자신의 백그라운드 작업은 계속 돌 수 있습니다. 끄면 하위 에이전트 자신의 기록으로 판단합니다.",
  "OMP on macOS herdr-core: chat from the session it holds open": "OMP (macOS herdr-core): 열어 둔 세션에서 채팅 읽기",
  "On a Mac running herdr-core, an OMP pane's chat comes from the session file its omp holds open, read with lsof, so omp -c and resumed sessions show their chat. When off, the chat there falls back to the terminal.": "herdr-core를 쓰는 Mac에서 OMP 창의 채팅을 omp가 열어 둔 세션 파일에서 lsof로 읽어, omp -c와 이어 연 세션도 채팅이 보입니다. 끄면 그곳의 채팅은 터미널로 돌아갑니다.",
};

/**
 * Korean for the settings keys of Settings → Chat → Composer's optional buttons and chips, and of Settings → Terminal → Split into rows and columns: the rest of the
 * settings part (./settings.ko.ts), kept apart so each file stays short. Both files are the one settings part,
 * so a key lives in only one of them; its header lists the settings files and the register.
 */
export const SETTINGS_COMPOSER_KO: Record<string, string> = {
  "Look for repos inside this folder": "하위 저장소 포함",
  "Include repositories below the pane's folder, even when ignored by the parent repository. Saved on this device.": "패널 폴더 아래의 저장소를 포함합니다. 상위 저장소가 무시하는 저장소도 찾으며, 이 기기에 저장합니다.",
  "How deep to look": "저장소 탐색 깊이",
  "Folder levels below the pane's folder. A deeper search can take longer.": "패널 폴더 아래로 탐색할 단계 수입니다. 깊을수록 시간이 더 걸릴 수 있습니다.",
  "New tab button": "새 탭 버튼",
  "A button in the message box opens New tab with an agent… on the pane's workspace. The tab menu offers it either way.": "입력창의 버튼으로 이 패널의 워크스페이스에 에이전트와 함께 새 탭…을 엽니다. 탭 메뉴에서는 언제든 열 수 있습니다.",
  "Artifacts chip": "아티팩트 칩",
  "A chip in a Claude Code pane's message box lists the pages its session published with the Artifact tool.": "Claude Code 패널의 입력창에 세션이 Artifact 도구로 게시한 페이지 목록을 여는 칩을 표시합니다.",
  "Side conversations chip (experimental)": "곁가지 대화 칩 (실험적)",
  "A chip in an OMP pane's message box lists the side conversations its session saved with /btw.": "OMP 패널의 입력창에 세션이 /btw로 저장한 곁가지 대화 목록을 여는 칩을 표시합니다.",
  "Paste and send button": "붙여넣고 보내기 버튼",
  "A button in the empty message box sends the text copied on this device as a message.": "빈 입력창의 버튼으로 이 기기에서 복사한 글을 메시지로 보냅니다.",
  "Split into rows and columns": "행과 열로 나누기",
  "Drop a pane on the edge of another in the split view to open it beside, above or below that pane, up to four at once, and drag the line between two panes to resize them. Off: the split view keeps two halves side by side.": "분할 보기에서 패널을 다른 패널의 가장자리에 놓으면 그 패널의 옆, 위, 아래에 열립니다. 한 번에 넷까지 열 수 있고, 두 패널 사이의 선을 끌어 크기를 바꿉니다. 끄면 분할 보기는 좌우 두 칸으로 나뉩니다.",
};

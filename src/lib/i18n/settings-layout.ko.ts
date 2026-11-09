/**
 * Korean for the settings keys of Settings' search and the layout of its pages: the rest of the
 * settings part (./settings.ko.ts), kept apart so each file stays short. They are all the one settings part,
 * so a key lives in only one of them; its header lists the settings files and the register.
 */
export const SETTINGS_LAYOUT_KO: Record<string, string> = {
  "Search settings": "설정 검색",
  "No settings match.": "일치하는 설정이 없습니다.",
  "Search results": "검색 결과",
  "Open {page}": "{page} 열기",
  "Sidebar": "사이드바",
  "Show dark themes": "다크 테마 보기",
  "Show light themes": "라이트 테마 보기",
  "Earlier themes": "이전 테마",
  "Later themes": "다음 테마",
  "More settings": "설정 더 보기",
  "Experimental": "실험 기능",
  "Start a replaced server again": "다른 PC의 교체된 서버 다시 시작",
  "When installing Ovis over SSH in place of one started by hand fails or is cancelled, start that one again as it was. When off, it stays stopped, as before.": "SSH로 손으로 띄운 Ovis를 바꿔 설치하다 실패하거나 취소하면, 그 서버를 원래대로 다시 시작합니다. 끄면 이전처럼 멈춘 채로 둡니다.",
  "{count} changed": "{count}개 바꿈",
  "By state": "상태별",
  "Hidden": "숨김",
  "Folded": "접어서",
  "Expanded": "펼쳐서",
  "Both": "둘 다",
  "Waiting first keeps herdr's order with the agents that need you on top, and folds the resting ones under one line. Activity keeps a waiting agent on top, then the one that changed last. By state lists the agents above the workspaces on this device: the ones that need you first, then working, done and idle. herdr's own order is not changed.": "응답 필요 먼저는 herdr 순서를 지키되 답이 필요한 에이전트를 맨 위에 두고, 쉬는 에이전트는 한 줄 아래로 접습니다. 활동순은 답을 기다리는 에이전트를 맨 위에, 그다음 가장 최근에 바뀐 순서입니다. 상태별은 이 기기에서 에이전트를 워크스페이스 위에 모아 답 필요·작업 중·완료·준비됨 순으로 보여 줍니다. herdr 자체의 순서는 바뀌지 않습니다.",
  "The agent's reasoning blocks: left out, folded to one line, or open. One you open or fold stays that way for its message.": "에이전트의 추론 블록을 빼거나, 한 줄로 접거나, 펼쳐서 보여 줍니다. 직접 펼치거나 접은 블록은 그 메시지에서 그대로 유지됩니다.",
  "Drops fillers and fixes spacing; code and paths stay as spoken. Where it is off, the text stays exactly as transcribed.": "군말을 빼고 띄어쓰기를 고칩니다. 코드와 경로는 말한 그대로 둡니다. 꺼 둔 곳에서는 받아쓴 그대로 둡니다.",
  "Alert me when": "이럴 때 알림",
  "Long turn finished": "긴 작업 끝남",
  "Any turn finished": "작업 끝날 때마다",
  "Lock pinned agents": "고정 에이전트 잠그기",
  "OMP: side conversations chip": "OMP 곁가지 대화 칩",
  "A chip in an OMP pane's message box lists the side conversations its session saved with /btw.": "OMP 패널의 입력창에 세션이 /btw로 저장한 곁가지 대화 목록을 여는 칩을 표시합니다.",
  "In use": "사용 중",
  "herdr's TUI server is not running: start herdr after the switch.": "herdr의 TUI 서버가 실행 중이 아닙니다. 전환한 뒤 herdr를 시작하세요.",
  "herdr's TUI server is not running.": "herdr의 TUI 서버가 실행 중이 아닙니다.",

  // the one-line conditions Settings' bare pages show under a row's name (design pass G-095 to G-098)
  "By state applies to this device; the other orders to every browser.": "상태별만 기기별, 나머지는 공유",
};

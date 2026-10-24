import { SETTINGS_KO } from "./i18n/settings.ko.ts";
import { TERMINAL_KO } from "./i18n/terminal.ko.ts";
import { COMPOSER_KO } from "./i18n/composer.ko.ts";
import { CHAT_KO } from "./i18n/chat.ko.ts";
import { SIDEBAR_KO } from "./i18n/sidebar.ko.ts";
import { MACHINES_KO } from "./i18n/machines.ko.ts";
import { WORKSPACE_KO } from "./i18n/workspace.ko.ts";
import { FILES_KO } from "./i18n/files.ko.ts";
import { DEVICES_KO } from "./i18n/devices.ko.ts";
import { USAGE_KO } from "./i18n/usage.ko.ts";
import { UPDATES_KO } from "./i18n/updates.ko.ts";
import { PALETTE_KO } from "./i18n/palette.ko.ts";

/**
 * Korean for every `t("…")` in src/ that no part in lib/i18n/ holds: keys more than one feature
 * uses, and the app shell's. KO at the end is this and the parts together. The English string is
 * the key. Grouped by where the text
 * shows; within a group, roughly in the order it appears. Register: labels and buttons as nouns
 * or ~하기, sentences in 합니다체. Fixed terms: 패널, 워크스페이스, 에이전트, 터미널, 채팅, 페어링,
 * 기기; product names (herdr, Tailscale, Codex, Claude Code) stay as they are. Placeholders in
 * braces keep their English names.
 */
const BASE: Record<string, string> = {
  "Working tree": "작업 트리",
  "Changes": "변경 사항",
  "Agent {status}": "에이전트 {status}",
  "Agent waiting on background work": "에이전트가 백그라운드 작업을 기다리는 중",
  "Files edited in this turn": "이 턴에서 편집한 파일",
  "Open working-tree diff for {path}": "{path}의 작업 트리 변경 사항 열기",
  "This file is outside the pane's repository.": "이 파일은 패널의 저장소 밖에 있습니다.",
  "Back": "뒤로",
  "Scroll pane up": "패널 위로 스크롤",
  "Scroll pane down": "패널 아래로 스크롤",
  "Find in terminal": "터미널에서 찾기",
  "Previous match": "이전 결과",
  "Next match": "다음 결과",
  "Close search": "검색 닫기",
  "No matches": "검색 결과 없음",
  "{current} of {total}": "{total}개 중 {current}",
  "Recent folders": "최근 폴더",
  "Dismiss": "닫기",
  "Input line": "입력창",
  // ---- settings ----
  "Settings": "설정",
  "Chat": "채팅",
  "Agent default": "에이전트 기본값",
  "Phone & devices": "폰 및 기기",
  "Install app": "앱 설치",

  // ---- shortcuts (lib/shortcuts.ts labels) ----
  "Command palette": "명령 팔레트",
  "Switch chat / terminal": "채팅 / 터미널 전환",
  "Focus pane input": "패널 입력창으로 이동",
  "Toggle sidebar": "사이드바 토글",
  "New workspace": "새 워크스페이스",
  "Previous pane": "이전 패널",
  "Next pane": "다음 패널",

  // ---- agent status words (lib/status.ts) ----
  "READY": "대기",
  "RUN": "실행",
  "INPUT": "입력",
  "DONE": "완료",
  "BG": "백그라운드",
  "—": "—",

  // ---- app header and shell ----
  "Opening link…": "링크 여는 중…",
  "Connecting to Ovis…": "Ovis에 연결하는 중…",
  "Close workspace list": "워크스페이스 목록 닫기",
  "Open workspace list": "워크스페이스 목록 열기",
  "Show workspace list": "워크스페이스 목록 보이기",
  "Hide workspace list": "워크스페이스 목록 숨기기",
  "Pane closed": "창이 닫혔습니다",
  "Show the terminal": "터미널 보기",
  "Show the chat": "채팅 보기",
  "Close this half": "이쪽 화면 닫기",
  "Toggle sidebar (⌘⇧B)": "사이드바 토글 (⌘⇧B)",
  "Chat transcript (⌘⇧J)": "채팅 기록 (⌘⇧J)",
  "Live terminal (⌘⇧J)": "실시간 터미널 (⌘⇧J)",
  "Live terminal: coming to Windows PCs once herdr can attach there": "실시간 터미널: herdr가 Windows에서 attach를 지원하면 열립니다",
  "soon": "준비 중",
  "Terminal": "터미널",
  "herdr {version} · protocol {protocol}": "herdr {version} · 프로토콜 {protocol}",
  "live": "연결됨",
  "disconnected": "끊김",
  "reconnecting": "재연결 중",
  "connecting": "연결 중",
  "herdr offline": "herdr 꺼짐",
  "Status unknown": "상태 알 수 없음",
  "herdr unavailable": "herdr 응답 없음",
  "The last health check failed. Last seen: herdr {version} · protocol {protocol}": "마지막 상태 확인에 실패했습니다. 마지막으로 확인한 상태: herdr {version} · 프로토콜 {protocol}",
  "The health check failed": "상태 확인에 실패했습니다",
  "Start herdr on this PC, or check HERDR_SOCKET.": "이 PC에서 herdr를 시작하거나 HERDR_SOCKET을 확인하세요.",
  "The other PC's answer was larger than this app accepts": "다른 PC의 응답이 이 앱이 받을 수 있는 크기보다 큽니다",
  "The other PC's answer could not be read": "다른 PC의 응답을 읽을 수 없습니다",
  "Browse files": "파일 찾아보기",
  "Copy link": "링크 복사",
  "Link copied": "링크를 복사했습니다",
  "That agent has closed: its workspace is open": "그 에이전트는 닫혔습니다. 대신 워크스페이스를 열었습니다",
  "That link's workspace is closed": "그 링크의 워크스페이스는 닫혔습니다",
  "That link's PC is not set up here": "그 링크의 PC는 여기에 설정되어 있지 않습니다",
  "Command palette (⌘⇧K)": "명령 팔레트 (⌘⇧K)",
  "Could not sign out. Try again.": "로그아웃하지 못했습니다. 다시 시도해 주세요.",
  "Retry": "다시 시도",
  "Notify me when a pane needs input or finishes": "패널이 입력을 기다리거나 끝나면 알려줍니다",
  "On, pushed to this device": "켜짐, 이 기기로 푸시",
  "Alerts on, pushed to this device, even with the app closed. Tap to turn them off": "알림 켜짐, 이 기기로 푸시됩니다. 앱을 닫아도 옵니다. 누르면 꺼집니다",
  "Off on this device": "이 기기에서 꺼짐",
  "More": "더 보기",
  "More · alerts are off": "더 보기 · 알림 꺼짐",
  "Alerts off on this device. Tap to turn them on": "이 기기에서 알림이 꺼져 있습니다. 누르면 켜집니다",
  "On in this tab": "이 탭에서 켜짐",
  "Alerts on while this tab is open. Tap to turn them off": "이 탭이 열려 있는 동안 알림이 옵니다. 누르면 꺼집니다",
  "On in the app": "앱 안에서 켜짐",
  "Alerts on in the app. Tap to allow them when it is closed too": "앱에서 알림 켜짐. 누르면 앱을 닫았을 때도 받도록 허용할 수 있습니다",
  "Alerts on in the app. Tap to turn them off": "앱에서 알림 켜짐. 누르면 꺼집니다",
  "Alerts on while this tab is open (closed-app alerts need https, and on iPhone the home-screen app). Tap to turn them off": "이 탭이 열려 있는 동안 알림이 옵니다 (앱을 닫은 뒤의 알림은 https가 필요하고, iPhone에서는 홈 화면 앱이어야 합니다). 누르면 꺼집니다",

  // ---- sidebar ----
  "Rename pane": "패널 이름 바꾸기",
  "Branch": "브랜치",
  "Opening…": "여는 중…",
  "Detached HEAD": "분리된 HEAD",
  "Delete": "삭제",
  "Close": "닫기",
  "Rename failed: {reason}": "이름 바꾸기 실패: {reason}",

  // ---- PCs sidebar ----
  "Connecting…": "연결 중…",
  "Connected": "연결됨",
  "Reconnecting…": "재연결 중…",
  "Add PC": "PC 추가",
  "Connect": "연결",
  "Step {n} of {total}": "{total}단계 중 {n}",
  "{done} of {total}": "{total} 중 {done}",

  // ---- command palette ----
  "Refresh": "새로 고침",
  "Search panes and actions": "패널과 동작 검색",

  // ---- new workspace ----
  "Browse": "찾아보기",
  "Cancel": "취소",
  "Starting…": "시작 중…",
  "Start": "시작",
  // the launch's model, effort, first message and skills (lib/agentLaunchMode.ts, lib/newSession.ts)

  // ---- folder browser ----
  "No matching folders": "일치하는 폴더가 없습니다",
  "This folder cannot be opened.": "이 폴더를 열 수 없습니다.",
  "Folders could not be loaded.": "폴더를 불러올 수 없습니다.",

  // ---- files ----
  "Files": "파일",
  "This image is {size}; download it to view.": "이 이미지는 {size}입니다. 보려면 다운로드하세요.",
  "Download": "내려받기",
  "Open {path}": "{path} 열기",

  // ---- PC dialog ----
  "Continue": "계속",

  // ---- updates ----
  "Reload app": "앱 새로 고침",
  "Details": "자세히",


  // ---- prompt card ----
  "Submit": "제출",
  "Recommended": "추천",


  // ---- composer ----
  "Drag to resize · double-click to reset": "끌어서 크기 조절 · 두 번 클릭하면 초기화",
  "Failed": "실패",
  "Send now": "지금 보내기",

  // ---- chat view ----
  "Copied": "복사됨",
  "Worked for {duration}": "{duration} 작업",
  "Copy message": "메시지 복사",
  "terminal ended": "터미널 종료됨",
  "{m}m": "{m}분",
  "{h}h {m}m": "{h}시간 {m}분",

  // ---- terminal ----
  "The question on screen changed; check it and answer again.": "화면의 질문이 바뀌었습니다. 확인하고 다시 답하세요.",
  "Reconnect": "다시 연결",
  "Discard": "버리기",
  "Held message — review and send": "보관된 메시지. 확인하고 보내세요",


  // ---- voice input ----
  "Dictate (hold)": "받아쓰기 (길게 누르기)",
  "Microphone permission was denied": "마이크 권한이 거부되었습니다",
  "Voice input needs HTTPS": "음성 입력에는 HTTPS가 필요합니다",
  // ---- errors (lib/userError.ts) ----
  "This browser is not signed in to this PC any more. Pair it again in Settings → Phone & devices.": "이 브라우저는 더 이상 이 PC에 로그인되어 있지 않습니다. 설정 → 폰 및 기기에서 다시 페어링하세요.",
  "That item no longer exists on the PC. Refresh and try again.": "그 항목은 PC에 더 이상 없습니다. 새로 고친 뒤 다시 시도하세요.",
  "It changed on the PC while you were acting. Check it and try again.": "작업하는 동안 PC에서 내용이 바뀌었습니다. 확인한 뒤 다시 시도하세요.",
  "The PC took too long to answer. Try again.": "PC가 너무 오래 응답하지 않았습니다. 다시 시도하세요.",
  "OpenCode did not confirm the answer. Check the question before sending again.": "OpenCode에서 답변을 받았는지 확인되지 않았습니다. 다시 보내기 전에 질문을 확인하세요.",
  "The PC could not do that. Try again; if it keeps failing, restart Ovis on the PC.": "PC에서 그 작업을 할 수 없었습니다. 다시 시도하고, 계속 실패하면 PC에서 Ovis를 다시 시작하세요.",
  "Can't reach the PC. Check your connection, then try again.": "PC에 연결할 수 없습니다. 연결을 확인한 뒤 다시 시도하세요.",
  "Something went wrong. Try again.": "문제가 생겼습니다. 다시 시도하세요.",
  "Not signed in to this PC": "이 PC에 로그인되어 있지 않음",
  "It no longer exists on the PC": "PC에 더 이상 없음",
  "It changed on the PC": "PC에서 내용이 바뀜",
  "The PC took too long": "PC 응답이 너무 늦음",
  "Can't reach the PC": "PC에 연결할 수 없음",
  "PC disk is full": "PC 디스크가 가득 참",
  "No permission on the PC": "PC에서 권한 없음",
  "Pair it again in Settings → Phone & devices.": "설정 → 폰 및 기기에서 다시 페어링하세요.",
  "Refresh and try again.": "새로 고친 뒤 다시 시도하세요.",
  "Check it and try again.": "확인한 뒤 다시 시도하세요.",
  "Check your connection, then try again.": "연결을 확인한 뒤 다시 시도하세요.",
  "Try again; if it keeps failing, restart Ovis on the PC.": "다시 시도하고, 계속 실패하면 PC에서 Ovis를 다시 시작하세요.",
  "The server cannot save settings: check that its state folder is writable.": "서버가 설정을 저장할 수 없습니다. 서버의 상태 폴더에 쓸 수 있는지 확인하세요.",


  // ---- devices ----
  "Loading…": "불러오는 중…",
  "Done": "완료",

  // ---- phone ----
  "Copy": "복사",
  "…": "…",
  "Alerts": "알림",
  "Sending…": "보내는 중…",
  "Needs input": "입력 필요",
  "Finished": "작업 완료",
  "Open pane": "패널 열기",
  "Quick replies": "빠른 답장",
  "Skills": "스킬",
  "Not sent: send or discard the held input first.": "보내지 못했습니다: 보관한 입력을 먼저 보내거나 버리세요.",
  "Queue could not be saved. Keep this tab open or copy the messages before reloading.": "대기 메시지를 저장하지 못했습니다. 이 탭을 유지하거나 새로고침 전에 메시지를 복사하세요.",
  "Queued messages": "대기 메시지",
  "Not confirmed. Check the terminal before sending again.": "전송 여부를 확인하지 못했습니다. 다시 보내기 전에 터미널을 확인하세요.",
  "Too large to attach: {name} ({size}). A file can be up to {limit}.": "첨부하기에는 너무 큽니다: {name} ({size}). 파일은 {limit}까지 첨부할 수 있습니다.",
  // ---- subscription usage ----
  "Move {name} up": "{name} 위로 이동",
  "Move {name} down": "{name} 아래로 이동",
  "Subscription usage": "구독 사용량",
  "Resets in {time}": "{time} 후 초기화",
  "{n} background task": "백그라운드 작업 {n}개",
  "{n} background tasks": "백그라운드 작업 {n}개",
  "Try again": "다시 시도",
  // tabs: the strip over the pane, and the New tab dialog
  "New tab": "새 탭",
  "Zoom pane": "패널 확대",
  "Unzoom pane": "패널 확대 해제",
  "This PC's bridge does not offer this yet": "이 PC의 브리지는 아직 이 기능을 제공하지 않습니다.",
  "Split pane right": "패널을 오른쪽으로 분할",
  "Split pane down": "패널을 아래로 분할",
  "Plan: {done} of {total} done": "계획: {total}개 중 {done}개 완료",
  "Plan": "계획",
  "Something went wrong": "문제가 발생했습니다",
  "The app hit an error and stopped drawing. Your terminals keep running in herdr.": "앱에 오류가 발생해 화면을 그리지 못했습니다. 터미널은 herdr에서 계속 실행 중입니다.",
  "Copy details": "자세한 내용 복사",
  "This pane can't be shown.": "이 패널을 표시할 수 없습니다.",
  "The sidebar can't be shown.": "사이드바를 표시할 수 없습니다.",
  "Diff layout": "비교 보기 방식",
  "Unified": "한 열",
  "Split": "나란히",
  // t3code ports (a)
  // t3code ports (d)
  "Change PC": "PC 바꾸기",
};

/** The parts KO is made of; src/lib/i18n.test.ts fails when a key is in two parts, since a spread keeps only the last. */
export const KO_PARTS: Record<string, Record<string, string>> = {
  base: BASE,
  settings: SETTINGS_KO,
  terminal: TERMINAL_KO,
  composer: COMPOSER_KO,
  chat: CHAT_KO,
  sidebar: SIDEBAR_KO,
  machines: MACHINES_KO,
  workspace: WORKSPACE_KO,
  files: FILES_KO,
  devices: DEVICES_KO,
  usage: USAGE_KO,
  updates: UPDATES_KO,
  palette: PALETTE_KO,
};

export const KO: Record<string, string> = Object.assign({}, ...Object.values(KO_PARTS));

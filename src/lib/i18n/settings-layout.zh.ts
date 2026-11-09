/**
 * Chinese for the settings keys of Settings' search and the layout of its pages: the rest of the
 * settings part (./settings.zh.ts), kept apart so each file stays short. They are all the one settings part,
 * so a key lives in only one of them; its header lists the settings files and the register.
 */
export const SETTINGS_LAYOUT_ZH: Record<string, string> = {
  "Search settings": "搜索设置",
  "No settings match.": "没有匹配的设置。",
  "Search results": "搜索结果",
  "Open {page}": "打开 {page}",
  "Sidebar": "侧边栏",
  "Show dark themes": "显示深色主题",
  "Show light themes": "显示浅色主题",
  "Earlier themes": "上一组主题",
  "Later themes": "下一组主题",
  "More settings": "更多设置",
  "Experimental": "实验功能",
  "Start a replaced server again": "重新启动被替换的服务器",
  "When installing Ovis over SSH in place of one started by hand fails or is cancelled, start that one again as it was. When off, it stays stopped, as before.": "通过 SSH 替换手动启动的 Ovis 时，如果安装失败或被取消，则按原样重新启动该服务器。关闭时，它会像以前一样保持停止。",
  "{count} changed": "已更改 {count} 项",
  "By state": "按状态",
  "Hidden": "隐藏",
  "Folded": "折叠",
  "Expanded": "展开",
  "Both": "两者",
  "Waiting first keeps herdr's order with the agents that need you on top, and folds the resting ones under one line. Activity keeps a waiting agent on top, then the one that changed last. By state lists the agents above the workspaces on this device: the ones that need you first, then working, done and idle. herdr's own order is not changed.": "等待的优先会保持 herdr 的顺序，只把需要你处理的代理移到最上面，并把空闲的代理折叠到一行下。按活动排序会把等待回复的代理放在最上面，其次是最近有变化的。按状态会在此设备上把代理列在工作区上方：先是需要你处理的，然后是工作中、已完成和空闲的。herdr 自身的顺序不会改变。",
  "The agent's reasoning blocks: left out, folded to one line, or open. One you open or fold stays that way for its message.": "代理的推理块：不显示、折叠为一行或展开。你手动展开或折叠的块在该消息中保持不变。",
  "Drops fillers and fixes spacing; code and paths stay as spoken. Where it is off, the text stays exactly as transcribed.": "去掉口头填充词并修正空格；代码和路径保持原样。关闭的地方保留转写原文。",
  "Alert me when": "提醒我",
  "Long turn finished": "长回合完成",
  "Any turn finished": "每回合完成",
  "Lock pinned agents": "锁定固定的代理",
  "OMP: side conversations chip": "OMP 旁支对话标签",
  "A chip in an OMP pane's message box lists the side conversations its session saved with /btw.": "在 OMP 窗格的输入框中显示一个标签，列出该会话用 /btw 保存的旁支对话。",
  "In use": "使用中",
  "herdr's TUI server is not running: start herdr after the switch.": "herdr 的 TUI 服务器未运行：切换后请启动 herdr。",
  "herdr's TUI server is not running.": "herdr 的 TUI 服务器未运行。",

  // the one-line conditions Settings' bare pages show under a row's name (design pass G-095 to G-098)
  "By state applies to this device; the other orders to every browser.": "按状态仅对此设备生效，其他排序对所有浏览器生效。",
};

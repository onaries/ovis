/**
 * Chinese for the settings keys of Settings → Chat → Composer's optional buttons and chips (and their one row of chips), of Settings → Agents → Other agents herdr knows, of Settings → Chat → Compaction and failed requests, of Settings → Terminal → Codex panes, of Settings → Appearance → Background workspaces apart, and of Settings → Shortcuts → herdr prefix keys: the rest of the
 * settings part (./settings.zh.ts), kept apart so each file stays short. Both files are the one settings part,
 * so a key lives in only one of them; its header lists the settings files and the register.
 */
export const SETTINGS_COMPOSER_ZH: Record<string, string> = {
  "Look for repos inside this folder": "包含子仓库",
  "Include repositories below the pane's folder, even when ignored by the parent repository. Saved on this device.": "包含窗格文件夹下的仓库，即使父仓库忽略了它们。保存在此设备上。",
  "How deep to look": "仓库搜索深度",
  "Folder levels below the pane's folder. A deeper search can take longer.": "从窗格文件夹向下搜索的层数。搜索越深，耗时可能越长。",
  "Paste and send button": "粘贴并发送按钮",
  "A button in the empty message box sends the text copied on this device as a message.": "空输入框中的按钮会把在此设备上复制的文本作为消息发送。",

  "Background workspaces apart": "单独放置后台工作区",
  "Go to tab 1-9": "转到第 1-9 个标签页",
  "Prefix": "前缀键",
  "This PC's server does not report herdr's keys yet.": "此 PC 的服务器尚未报告 herdr 的按键。",
  "Use herdr's prefix keys": "使用 herdr 前缀键",
  "herdr prefix keys": "herdr 前缀键",
  "herdr's prefix in its config.toml cannot be used here, so no key is taken.": "config.toml 中的 herdr 前缀键无法在此使用，因此不会占用任何按键。",
  "herdr's prefix, then a key that herdr's config.toml on this PC binds, runs that action here; the actions are listed below. The prefix then no longer reaches the pane (press it twice to send it), while fields, dialogs and IME input keep their keys.": "按下 herdr 前缀键后，再按此 PC 的 herdr config.toml 绑定的键，即可在这里执行下方列出的操作。前缀键将不再发送到窗格（按两次即可发送），输入框、对话框和输入法输入保留其按键。",
  "Codex panes: let Codex select and scroll": "Codex 窗格：由 Codex 选择和滚动",
  "Composer buttons": "输入框按钮",
  "Artifacts (Claude Code)": "工件 (Claude Code)",
  "Suggestion": "建议",
  "Suggestion chip": "建议标签",
  "Artifacts chip": "Artifact 标签",
  "A chip above the message box puts the prompt the agent suggests next (Claude Code, GJC or omp) into the box. With a keyboard, Tab does it.": "输入框上方的标签会把 Agent（Claude Code、GJC、omp）建议的下一条提示填入输入框。使用键盘时按 Tab 即可。",
  "A chip in a Claude Code pane's message box lists the pages its session published with the Artifact tool.": "在 Claude Code 面板的输入框中显示一个标签，列出该会话用 Artifact 工具发布的页面。",
  "The site in that tab can see and navigate this Ovis tab.": "该标签页中的网站可以查看并跳转这个 Ovis 标签页。",
};

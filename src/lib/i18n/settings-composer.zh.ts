/**
 * Chinese for the settings keys of Settings → Chat → Composer's optional buttons and chips, and of Settings → Terminal → Split into rows and columns: the rest of the
 * settings part (./settings.zh.ts), kept apart so each file stays short. Both files are the one settings part,
 * so a key lives in only one of them; its header lists the settings files and the register.
 */
export const SETTINGS_COMPOSER_ZH: Record<string, string> = {
  "Look for repos inside this folder": "包含子仓库",
  "Include repositories below the pane's folder, even when ignored by the parent repository. Saved on this device.": "包含窗格文件夹下的仓库，即使父仓库忽略了它们。保存在此设备上。",
  "How deep to look": "仓库搜索深度",
  "Folder levels below the pane's folder. A deeper search can take longer.": "从窗格文件夹向下搜索的层数。搜索越深，耗时可能越长。",
  "New tab button": "新标签页按钮",
  "A button in the message box opens New tab with an agent… on the pane's workspace. The tab menu offers it either way.": "输入框中的按钮可在该面板的工作区打开“带代理的新标签页…”。标签页菜单中始终可用。",
  "Artifacts chip": "Artifact 标签",
  "A chip in a Claude Code pane's message box lists the pages its session published with the Artifact tool.": "在 Claude Code 面板的输入框中显示一个标签，列出该会话用 Artifact 工具发布的页面。",
  "Side conversations chip (experimental)": "旁支对话标签（实验性）",
  "A chip in an OMP pane's message box lists the side conversations its session saved with /btw.": "在 OMP 窗格的输入框中显示一个标签，列出该会话用 /btw 保存的旁支对话。",
  "Paste and send button": "粘贴并发送按钮",
  "A button in the empty message box sends the text copied on this device as a message.": "空输入框中的按钮会把在此设备上复制的文本作为消息发送。",
  "Split into rows and columns": "按行和列拆分",
  "Drop a pane on the edge of another in the split view to open it beside, above or below that pane, up to four at once, and drag the line between two panes to resize them. Off: the split view keeps two halves side by side.": "在拆分视图中把窗格放到另一个窗格的边缘，即可在它的旁边、上方或下方打开，最多同时四个；拖动两个窗格之间的线可调整大小。关闭时，拆分视图保持左右两半。",
};

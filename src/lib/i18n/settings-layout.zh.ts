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
  "More settings": "更多设置",
  "Experimental": "实验功能",
  "{count} changed": "已更改 {count} 项",
  "By state": "按状态",
  "Hidden": "隐藏",
  "Folded": "折叠",
  "Expanded": "展开",
  "Both": "两者",
  "Activity keeps a waiting agent on top, then the one that changed last. By state lists the agents above the workspaces on this device: the ones that need you first, then working, done and idle. herdr's own order is not changed.": "按活动排序会把等待回复的代理放在最上面，其次是最近有变化的。按状态会在此设备上把代理列在工作区上方：先是需要你处理的，然后是工作中、已完成和空闲的。herdr 自身的顺序不会改变。",
  "The agent's reasoning blocks: left out, folded to one line, or open. One you open or fold stays that way for its message.": "代理的推理块：不显示、折叠为一行或展开。你手动展开或折叠的块在该消息中保持不变。",
  "Drops fillers and fixes spacing; code and paths stay as spoken. Where it is off, the text stays exactly as transcribed.": "去掉口头填充词并修正空格；代码和路径保持原样。关闭的地方保留转写原文。",
};

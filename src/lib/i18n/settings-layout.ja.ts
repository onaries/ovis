/**
 * Japanese for the settings keys of Settings' search and the layout of its pages: the rest of the
 * settings part (./settings.ja.ts), kept apart so each file stays short. They are all the one settings part,
 * so a key lives in only one of them; its header lists the settings files and the register.
 */
export const SETTINGS_LAYOUT_JA: Record<string, string> = {
  "Search settings": "設定を検索",
  "No settings match.": "一致する設定はありません。",
  "Search results": "検索結果",
  "Open {page}": "{page} を開く",
  "Sidebar": "サイドバー",
  "More settings": "その他の設定",
  "Experimental": "試験的な機能",
  "{count} changed": "{count} 件変更",
  "By state": "状態別",
  "Hidden": "非表示",
  "Folded": "折りたたみ",
  "Expanded": "展開",
  "Both": "両方",
  "Activity keeps a waiting agent on top, then the one that changed last. By state lists the agents above the workspaces on this device: the ones that need you first, then working, done and idle. herdr's own order is not changed.": "アクティビティ順では、応答待ちのエージェントを先頭に、次に最近変化した順に並べます。状態別では、このデバイスでエージェントをワークスペースの上に表示します。対応が必要なものが先で、次に作業中、完了、待機の順です。herdr 自体の順序は変わりません。",
  "The agent's reasoning blocks: left out, folded to one line, or open. One you open or fold stays that way for its message.": "エージェントの推論ブロックを、表示しない・1 行に折りたたむ・展開する、から選びます。自分で開いたり折りたたんだりしたブロックは、そのメッセージではそのままです。",
  "Drops fillers and fixes spacing; code and paths stay as spoken. Where it is off, the text stays exactly as transcribed.": "言いよどみを除き、スペースを整えます。コードとパスは話したとおりに残します。オフの場所では書き起こしたままにします。",
};

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
  "Show dark themes": "ダークテーマを表示",
  "Show light themes": "ライトテーマを表示",
  "Earlier themes": "前のテーマ",
  "Later themes": "次のテーマ",
  "More settings": "その他の設定",
  "Experimental": "試験的な機能",
  "Start a replaced server again": "置き換えたサーバーを再起動",
  "When installing Ovis over SSH in place of one started by hand fails or is cancelled, start that one again as it was. When off, it stays stopped, as before.": "手動で起動した Ovis を SSH で置き換えるインストールが失敗またはキャンセルされたら、そのサーバーを元どおりに再起動します。オフのときは以前と同じく停止したままです。",
  "{count} changed": "{count} 件変更",
  "By state": "状態別",
  "Hidden": "非表示",
  "Folded": "折りたたみ",
  "Expanded": "展開",
  "Both": "両方",
  "Waiting first keeps herdr's order with the agents that need you on top, and folds the resting ones under one line. Activity keeps a waiting agent on top, then the one that changed last. By state lists the agents above the workspaces on this device: the ones that need you first, then working, done and idle. herdr's own order is not changed.": "応答待ちを先頭では、herdr の順序のまま、対応が必要なエージェントだけを先頭に移し、休止中のエージェントは 1 行にまとめて折りたたみます。アクティビティ順では、応答待ちのエージェントを先頭に、次に最近変化した順に並べます。状態別では、このデバイスでエージェントをワークスペースの上に表示します。対応が必要なものが先で、次に作業中、完了、待機の順です。herdr 自体の順序は変わりません。",
  "The agent's reasoning blocks: left out, folded to one line, or open. One you open or fold stays that way for its message.": "エージェントの推論ブロックを、表示しない・1 行に折りたたむ・展開する、から選びます。自分で開いたり折りたたんだりしたブロックは、そのメッセージではそのままです。",
  "Drops fillers and fixes spacing; code and paths stay as spoken. Where it is off, the text stays exactly as transcribed.": "言いよどみを除き、スペースを整えます。コードとパスは話したとおりに残します。オフの場所では書き起こしたままにします。",
  "Alert me when": "通知するとき",
  "Long turn finished": "長いターンの完了",
  "Any turn finished": "毎ターンの完了",
  "Lock pinned agents": "固定したエージェントをロック",
  "OMP: side conversations chip": "OMP のサイド会話チップ",
  "A chip in an OMP pane's message box lists the side conversations its session saved with /btw.": "OMP ペインの入力欄に、セッションが /btw で保存したサイド会話の一覧を開くチップを表示します。",
  "In use": "使用中",
  "herdr's TUI server is not running: start herdr after the switch.": "herdr の TUI サーバーは動いていません。切り替えた後で herdr を起動してください。",
  "herdr's TUI server is not running.": "herdr の TUI サーバーは動いていません。",

  // the one-line conditions Settings' bare pages show under a row's name (design pass G-095 to G-098)
  "By state applies to this device; the other orders to every browser.": "状態別はこのデバイスだけに、ほかの並び順はすべてのブラウザーに適用されます。",
};

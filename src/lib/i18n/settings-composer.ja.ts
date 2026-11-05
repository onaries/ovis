/**
 * Japanese for the settings keys of Settings → Chat → Composer's optional buttons and chips, and of Settings → Terminal → Split into rows and columns: the rest of the
 * settings part (./settings.ja.ts), kept apart so each file stays short. Both files are the one settings part,
 * so a key lives in only one of them; its header lists the settings files and the register.
 */
export const SETTINGS_COMPOSER_JA: Record<string, string> = {
  "Look for repos inside this folder": "子リポジトリを含める",
  "Include repositories below the pane's folder, even when ignored by the parent repository. Saved on this device.": "ペインのフォルダー以下のリポジトリを含めます。親が無視するものも検索します。この端末に保存します。",
  "How deep to look": "リポジトリの検索深度",
  "Folder levels below the pane's folder. A deeper search can take longer.": "ペインのフォルダーから何階層下まで検索するかを指定します。深い検索には時間がかかる場合があります。",
  "New tab button": "新しいタブボタン",
  "A button in the message box opens New tab with an agent… on the pane's workspace. The tab menu offers it either way.": "入力欄のボタンで、このペインのワークスペースに「エージェント付きの新しいタブ…」を開きます。タブメニューからはいつでも開けます。",
  "Artifacts chip": "アーティファクトチップ",
  "A chip in a Claude Code pane's message box lists the pages its session published with the Artifact tool.": "Claude Code のペインの入力欄に、セッションが Artifact ツールで公開したページの一覧を出すチップを表示します。",
  "Side conversations chip (experimental)": "サイド会話チップ（実験的）",
  "A chip in an OMP pane's message box lists the side conversations its session saved with /btw.": "OMP ペインの入力欄に、セッションが /btw で保存したサイド会話の一覧を開くチップを表示します。",
  "Paste and send button": "貼り付けて送信ボタン",
  "A button in the empty message box sends the text copied on this device as a message.": "空の入力欄のボタンで、このデバイスでコピーしたテキストをメッセージとして送ります。",
  "Split into rows and columns": "行と列に分割",
  "Drop a pane on the edge of another in the split view to open it beside, above or below that pane, up to four at once, and drag the line between two panes to resize them. Off: the split view keeps two halves side by side.": "分割表示でペインを別のペインの端にドロップすると、そのペインの横、上、下に開きます。同時に4つまで開け、2つのペインの間の線をドラッグするとサイズを変えられます。オフ：分割表示は左右2つのままです。",
};

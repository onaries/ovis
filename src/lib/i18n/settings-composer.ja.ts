/**
 * Japanese for the settings keys of Settings → Chat → Composer's optional buttons and chips, of Settings → Chat → Compaction and failed requests, of Settings → Terminal → Split into rows and columns and Codex panes, of Settings → Appearance → Background workspaces apart, and of Settings → Shortcuts → herdr prefix keys: the rest of the
 * settings part (./settings.ja.ts), kept apart so each file stays short. Both files are the one settings part,
 * so a key lives in only one of them; its header lists the settings files and the register.
 */
export const SETTINGS_COMPOSER_JA: Record<string, string> = {
  "Look for repos inside this folder": "子リポジトリを含める",
  "Include repositories below the pane's folder, even when ignored by the parent repository. Saved on this device.": "ペインのフォルダー以下のリポジトリを含めます。親が無視するものも検索します。この端末に保存します。",
  "How deep to look": "リポジトリの検索深度",
  "Folder levels below the pane's folder. A deeper search can take longer.": "ペインのフォルダーから何階層下まで検索するかを指定します。深い検索には時間がかかる場合があります。",
  "Paste and send button": "貼り付けて送信ボタン",
  "A button in the empty message box sends the text copied on this device as a message.": "空の入力欄のボタンで、このデバイスでコピーしたテキストをメッセージとして送ります。",
  "Split into rows and columns": "行と列に分割",
  "Drop a pane on the edge of another in the split view to open it beside, above or below that pane, up to four at once, and drag the line between two panes to resize them. Off: the split view keeps two halves side by side.": "分割表示でペインを別のペインの端にドロップすると、そのペインの横、上、下に開きます。同時に4つまで開け、2つのペインの間の線をドラッグするとサイズを変えられます。オフ：分割表示は左右2つのままです。",
  "Compaction and failed requests": "圧縮と失敗したリクエスト",
  "On this device, a compaction names the token counts the agent recorded with it, and each run of back-to-back failed requests shows as one row that opens to their errors. OmO, omp and pi record them.": "この端末で、会話の圧縮にエージェントが記録したトークン数を表示し、続けて失敗したリクエストを 1 行にまとめて、開くとエラーが見られるようにします。OmO、omp、pi が記録します。",
  "Background workspaces apart": "バックグラウンドのワークスペースを分ける",
  "On this device, workspaces a tool tagged role=background (herdr workspace report-metadata --token role=background) stand after the others under a folded Background workspaces heading. The open one, and one whose agent asks a question, stay in sight.": "このデバイスでは、ツールが role=background のタグを付けたワークスペース(herdr workspace report-metadata --token role=background)を、ほかのワークスペースの後ろの折りたたまれた「バックグラウンドのワークスペース」見出しの下に置きます。開いているワークスペースと、エージェントが質問しているワークスペースは表示されたままです。",
  "Go to tab 1-9": "1〜9番目のタブへ移動",
  "Prefix": "プレフィックス",
  "This PC's server does not report herdr's keys yet.": "このPCのサーバーはまだherdrのキーを報告していません。",
  "Use herdr's prefix keys": "herdrのプレフィックスキーを使う",
  "herdr prefix keys": "herdrのプレフィックスキー",
  "herdr's prefix in its config.toml cannot be used here, so no key is taken.": "config.tomlのherdrプレフィックスはここでは使えないため、キーは取得しません。",
  "herdr's prefix, then a key herdr's config.toml on this PC binds, runs that action here: the ones listed below. The prefix no longer reaches the pane: press it twice to send it. Fields, dialogs and IME input keep their keys.": "herdrのプレフィックスに続けて、このPCのherdr config.tomlが割り当てたキーを押すと、下に挙げた操作がここで実行されます。プレフィックスはペインに届かなくなります。送るには2回押してください。入力欄、ダイアログ、IME入力はキーをそのまま受け取ります。",
  "Codex panes: let Codex select and scroll": "Codex ペイン：Codex で選択とスクロール",
  "On this device, a drag in a Codex pane goes to Codex, which selects through its whole history and scrolls it while the drag is held past the top or bottom edge. Ctrl+C or Enter copies it, but on herdr that copy does not reach this device's clipboard: Shift+drag (Option+drag on a Mac) still selects, copies and quotes in Ovis, up to the screen's edge.": "このデバイスでは、Codex ペインでのドラッグが Codex に渡り、履歴全体から選択し、上端や下端の外でドラッグを保つと履歴をスクロールします。Ctrl+C か Enter でコピーしますが、herdr ではそのコピーはこのデバイスのクリップボードに届きません。Shift+ドラッグ（Mac は Option+ドラッグ）なら、今まで通り Ovis で画面の端まで選択、コピー、引用できます。",
};

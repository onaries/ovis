/**
 * Japanese for the settings keys of Settings → Appearance's agent rows: the rest of the settings part
 * (./settings.ja.ts), kept apart so each file stays short. All these files are the one settings
 * part, so a key lives in only one of them; ./settings.ja.ts's header lists the settings files and the register.
 */
export const SETTINGS_AGENTS_JA: Record<string, string> = {
  "OpenCode: subagent ends from their session": "OpenCode: サブエージェントの終了を親セッションから読む",
  "An OpenCode subagent counts as running, and holds its turn's BG wait, until the session that started it is told it ended, not as soon as the subagent goes idle. Its own background work may still run then. When off, the subagent's own rows tell.": "OpenCode のサブエージェントは、アイドルになった時点ではなく、それを始めたセッションに終了が伝えられるまで実行中として数え、そのターンの BG 待機も保ちます。そのとき、サブエージェント自身のバックグラウンド作業はまだ動いていることがあります。オフのときは、サブエージェント自身の記録で判断します。",
  "OMP on macOS herdr-core: chat from the session it holds open": "OMP（macOS の herdr-core）: 開いているセッションからチャットを読む",
  "On a Mac running herdr-core, an OMP pane's chat comes from the session file its omp holds open, read with lsof, so omp -c and resumed sessions show their chat. When off, the chat there falls back to the terminal.": "herdr-core を使う Mac で、OMP ペインのチャットを omp が開いているセッションファイルから lsof で読みます。omp -c や再開したセッションもチャットが表示されます。オフにすると、そこではターミナル表示に戻ります。",
};

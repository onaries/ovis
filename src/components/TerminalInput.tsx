import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type Ref } from "react";
import { CornerDownLeft, SendHorizontal, TextCursorInput } from "lucide-react";

import "./TerminalInput.css";
import { readTerminalDraft, writeTerminalDraft, TERMINAL_LINE_LIMIT, subscribeTerminalDraft, terminalDraftSending, setTerminalDraftSending, acknowledgeTerminalDraft, terminalDraftVersion } from "../lib/terminalDraft.ts";

import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { MicButton, VoiceRecordingPill, useDictation } from "./VoiceInput.tsx";

export interface TerminalInputProps {
  owner: string;
  active?: boolean;
  /** an IME composition in the line: only the switch to direct typing waits for it */
  onComposing?: (active: boolean) => void;
  connected: boolean;
  /** true: sent, clear the line; a string: keep the text and say why; false: not sent (offline) */
  onSend: (text: string) => false | Promise<true | string>;
  /** an empty line's send: Enter alone, for a menu's default or a prompt that asks to continue;
   * true: sent, false: not sent (offline), a string: not sent, and why */
  onEnter: () => boolean | string;
  /** the line typed into the pane without Enter; true: typed, clear the line; a string: keep the text and say why; false: not sent (offline) */
  onInsert: (text: string) => false | Promise<true | string>;
  /** what a paste is for, read at the tap and again once the clipboard answers: the PC, pane and
   * connection; null while the pane cannot take one. A different answer cancels the paste. */
  pasteTarget?: () => string | null;
  /** a paste waits on the clipboard: the key bar's Paste is off meanwhile */
  onPasting?: (active: boolean) => void;
  /** the line took the focus */
  onFocus?: () => void;
  ref?: Ref<TerminalInputHandle>;
}

/** What the key bar's Paste asks of the line (PaneTerminal.tsx). */
export interface TerminalInputHandle {
  /** reads the clipboard for the line, from the user's own tap and for this line alone */
  paste(): void;
}

/** Lines the box grows to before it scrolls. */
const MAX_ROWS = 4;
/** How long a Send tapped mid-composition waits for the keyboard to commit the word. */
const COMMIT_WAIT_MS = 300;

/** A Send tapped mid-composition, waiting for the word to commit. */
interface SendAttempt {
  /** withdraws the tap at the deadline while a composition is open */
  timer: ReturnType<typeof setTimeout> | null;
  /** fixed at the tap: a chain of compositions cannot stretch the wait */
  deadline: number;
  /** the line held text at the tap: an empty commit then sends nothing, not a bare Enter */
  textSend: boolean;
}

/**
 * The terminal's input line on a touch screen. A phone's keyboard rewrites what it typed
 * (dictation revising a phrase, an IME finishing a syllable), and a terminal cannot take back
 * keys it already sent: every revision arrived as more text. Here the line is written with the
 * keyboard's own editing and goes to the pane whole, then Enter. Autocorrect and spell-check stay
 * off, as in the composer: they would swap a flag, path or branch name for a dictionary word.
 */
export function TerminalInput({ owner, active = true, connected, onSend, onEnter, onInsert, pasteTarget, onPasting, onComposing, onFocus, ref }: TerminalInputProps) {
  const t = useT();
  const text = useSyncExternalStore(subscribeTerminalDraft, () => readTerminalDraft(owner));
  const setText = useCallback((value: string | ((previous: string) => string)) => {
    // Read the owner record even after unmount: a late acknowledgement must not erase
    // edits made in a newly mounted input for the same pane.
    const next = typeof value === "function" ? value(readTerminalDraft(owner)) : value;
    writeTerminalDraft(owner, next);

  }, [owner]);
  const composing = useRef(false);
  /** compositions begun or ended, and selection changes, in the line: a paste waiting on the clipboard compares them (paste below) */
  const compositions = useRef(0);
  const selections = useRef(0);
  const composingCallback = useRef(onComposing);
  composingCallback.current = onComposing;
  useEffect(() => () => { composingCallback.current?.(false); }, []);

  const [note, setNote] = useState<string | null>(null);
  /** a paste waiting on the clipboard, said under the line while it does */
  const [pending, setPending] = useState<string | null>(null);
  const sending = useSyncExternalStore(subscribeTerminalDraft, () => terminalDraftSending(owner));
  const box = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const textRef = useRef(text);
  textRef.current = text;
  const { settings } = useSettings();
  const dictation = useDictation({
    mode: "terminal",
    active,
    connected,
    polish: settings.voicePolishTerminal,
    box,
    read: () => textRef.current,
    write: (value, caret) => {
      textRef.current = value;
      setText(value);
      requestAnimationFrame(() => {
        const element = box.current;
        if (!element) return;
        element.selectionStart = element.selectionEnd = caret;
        // without focus the browser does not follow the caret: a wrapped dictation's end would stay hidden
        if (caret === element.value.length) element.scrollTop = element.scrollHeight;
      });
    },
    onNote: setNote,
  });

  // A Send tapped while the keyboard still composes the last word (Gboard composes every word,
  // CJK IMEs an open syllable) finishes that word and sends once it commits. The button keeps
  // focus and the selection, so nothing in the tap commits the word: a blur does (Chrome ends the
  // composition on a focus change and fires compositionend at once), and the refocus inside the
  // same gesture keeps the keyboard up. A keyboard that still does not commit by the tap's deadline
  // gets the tap withdrawn with a note, so a later commit never sends on its own.
  const attempt = useRef<SendAttempt | null>(null);
  const clearPendingSend = useCallback(() => {
    const current = attempt.current;
    if (current?.timer != null) clearTimeout(current.timer);
    attempt.current = null;
  }, []);
  useEffect(() => clearPendingSend, [clearPendingSend]);
  // a drop withdraws the tap: a quick reconnect inside the wait must not send it after all
  useEffect(() => {
    if (connected || attempt.current === null) return;
    clearPendingSend();
    setNote(t("Not sent: the terminal is disconnected."));
  }, [clearPendingSend, connected, t]);
  const sendRef = useRef<(deferred: boolean) => void>(() => {});

  /** Waits for the commit until the tap's deadline, with "Finishing the word…" up meanwhile. */
  const awaitCommit = useCallback((current: SendAttempt) => {
    if (current.timer !== null) clearTimeout(current.timer);
    current.timer = null;
    const left = current.deadline - Date.now();
    if (left <= 0) {
      attempt.current = null;
      setNote(t("Finish the word, then send."));
      return;
    }
    setNote(t("Finishing the word…"));
    current.timer = setTimeout(() => {
      if (attempt.current !== current) return;
      attempt.current = null;
      setNote(t("Finish the word, then send."));
    }, left);
  }, [t]);

  const send = useCallback((deferred = false) => {
    // a deferred send runs only for a tap still waiting: a drop, a timeout or an emptied line withdrew it
    const current = attempt.current;
    if (deferred && current === null) return;
    if (!connected || terminalDraftSending(owner)) {
      // a send waiting for the commit must not leave "Finishing the word…" standing
      if (deferred) { clearPendingSend(); setNote(connected ? null : t("Not sent: the terminal is disconnected.")); }
      return;
    }
    if (composing.current) {
      if (deferred) {
        // a new composition after the commit: wait out what is left of the tap's window, no more
        awaitCommit(current!);
        return;
      }
      clearPendingSend();
      const tapped: SendAttempt = { timer: null, deadline: Date.now() + COMMIT_WAIT_MS, textSend: readTerminalDraft(owner).length > 0 };
      attempt.current = tapped;
      const element = box.current;
      if (element !== null && document.activeElement === element) {
        element.blur();
        element.focus({ preventScroll: true });
      }
      // committed inside the tap (Chrome, Gboard): compositionend already queued the send, no note
      if (composing.current && attempt.current === tapped) awaitCommit(tapped);
      return;
    }
    clearPendingSend();
    setNote(null);
    // the draft store, not the last render: a commit forced or delivered just now may not have rendered yet
    const draft = readTerminalDraft(owner);
    if (draft.length === 0) {
      // a text Send whose word came out empty (the preedit deleted or cancelled) is not an Enter
      if (deferred && current!.textSend) return;
      const entered = onEnter();
      if (typeof entered === "string") setNote(entered);
      else if (!entered) setNote(t("Not sent: the terminal is disconnected."));
      return;
    }
    const sent = onSend(draft);
    if (sent === false) { setNote(t("Not sent: the terminal is disconnected.")); return; }
    // a polish that lands before the acknowledgement would read as text typed meanwhile, and
    // leave the sent command in the line
    dictation.forget();
    setTerminalDraftSending(owner, true);
    void sent.then((result) => {
      if (result === true) {
        // text typed while it was on its way stays
        acknowledgeTerminalDraft(owner);
      } else setNote(result);
    }).catch(() => setNote(t("Not confirmed. Check the terminal before sending again."))).finally(() => { setTerminalDraftSending(owner, false); });
  }, [awaitCommit, clearPendingSend, connected, dictation.forget, onEnter, onSend, owner, t]);
  sendRef.current = send;

  /**
   * Types the line into the pane without Enter. The line clears only once the bridge says herdr
   * has the bytes, and then only the text that was sent: what was typed meanwhile stays, as after
   * Send. A refusal, a drop or no answer keeps the line with a note; nothing is tried again.
   */
  const insert = useCallback(() => {
    if (!connected || terminalDraftSending(owner)) return;
    // an open composition is the keyboard's: the committed word goes, not the preedit
    if (composing.current) { setNote(t("Finish the word, then insert.")); return; }
    clearPendingSend();
    setNote(null);
    const draft = readTerminalDraft(owner);
    if (draft.length === 0) return;
    // one line: nothing reports whether the program takes several as one paste, and a shell would
    // run each (shared/terminal-insert.ts), so a block is said here and nothing is sent
    if (/[\r\n]/.test(draft)) { setNote(t("Insert takes one line. Send several lines, or insert them one at a time.")); return; }
    const sent = onInsert(draft);
    if (sent === false) { setNote(t("Not inserted: the terminal is disconnected.")); return; }
    dictation.forget();
    setTerminalDraftSending(owner, true);
    void sent.then((result) => {
      if (result === true) acknowledgeTerminalDraft(owner);
      else setNote(result);
    }).catch(() => setNote(t("Not confirmed: the terminal did not confirm the text. Check it before inserting again."))).finally(() => { setTerminalDraftSending(owner, false); });
  }, [clearPendingSend, connected, dictation.forget, onInsert, owner, t]);

  /**
   * The key bar's Paste: the clipboard is read from the user's tap and for this line alone, at the
   * selection the tap found. What the paste is for is captured before the read (the PC, pane,
   * connection, role and input lease; the draft as written; where the caret is; the compositions
   * so far), since the browser may hold the read for a permission prompt: an answer that comes
   * after any of them changed, even and back again (a selection moved, a composition begun and
   * ended with nothing written, the pane's input lost and given again), or for a line no longer
   * shown, is dropped with a note. A refused or missing clipboard says to use the keyboard's own
   * paste; nothing is read in the background or retried.
   */
  const pasting = useRef(false);
  const paste = useCallback(() => {
    const element = box.current;
    if (pasting.current || element === null) return;
    if (composing.current) { setNote(t("Finish the word, then paste.")); return; }
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (typeof clipboard?.readText !== "function") { setNote(t("Paste is not available here. Use the keyboard's own paste in the input line.")); return; }
    const target = pasteTarget?.() ?? null;
    if (target === null) { setNote(t("Not pasted: the terminal is not ready.")); return; }
    const version = terminalDraftVersion(owner);
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const composed = compositions.current;
    const selected = selections.current;
    // a caret moved in the focused line, by touch or by script, while the read waits
    const moved = (): void => { if (document.activeElement === element) selections.current += 1; };
    document.addEventListener("selectionchange", moved);
    pasting.current = true;
    onPasting?.(true);
    setNote(null);
    setPending(t("Reading the clipboard…"));
    clipboard.readText().then((clip) => {
      if (!mounted.current || box.current !== element) return;
      const stale = composing.current || compositions.current !== composed || selections.current !== selected
        || element.selectionStart !== start || element.selectionEnd !== end
        || (pasteTarget?.() ?? null) !== target || terminalDraftVersion(owner) !== version;
      if (stale) {
        setNote(t("Not pasted: the line or the terminal changed meanwhile. Paste again."));
        return;
      }
      const text = clip.replace(/\r\n?/g, "\n");
      if (text.length === 0) { setNote(t("Nothing to paste: the clipboard is empty.")); return; }
      const current = readTerminalDraft(owner);
      const next = current.slice(0, start) + text + current.slice(end);
      writeTerminalDraft(owner, next);
      const written = readTerminalDraft(owner);
      const cut = next.length - written.length;
      setNote(cut > 0 ? t("Pasted up to the line's limit: {n} characters were left out.", { n: cut }) : null);
      const caret = Math.min(start + text.length, written.length);
      const pasted = terminalDraftVersion(owner);
      requestAnimationFrame(() => {
        // another pane picked, or the line written again, before the frame: its focus is not taken back
        if (box.current !== element || (pasteTarget?.() ?? null) !== target || terminalDraftVersion(owner) !== pasted) return;
        element.focus({ preventScroll: true });
        element.setSelectionRange(caret, caret);
      });
    }, () => {
      if (!mounted.current || box.current !== element) return;
      setNote(t("The clipboard could not be read. Use the keyboard's own paste in the input line."));
    }).finally(() => {
      document.removeEventListener("selectionchange", moved);
      pasting.current = false;
      onPasting?.(false);
      if (mounted.current) setPending(null);
    });
  }, [onPasting, owner, pasteTarget, t]);
  useImperativeHandle(ref, () => ({ paste }), [paste]);
  // a paste that outlives the line (a pane switch, the masked input taking its place) is dropped above; the bar's Paste comes back
  const pastingCallback = useRef(onPasting);
  pastingCallback.current = onPasting;
  useEffect(() => () => { if (pasting.current) pastingCallback.current?.(false); }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter breaks the line; an IME keeps its Enter, including the committing
    // one WebKit can send after compositionend as key code 229
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    send();
  };

  // wrapped lines count too: a dictated sentence is one long line, and its end must stay readable
  const [wrappedRows, setWrappedRows] = useState(1);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const line = parseFloat(style.lineHeight);
    if (!(line > 0)) return;
    const shown = element.rows;
    element.rows = 1;
    const content = element.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    element.rows = shown;
    setWrappedRows(Math.max(1, Math.round(content / line)));
  }, [text]);
  const rows = Math.min(MAX_ROWS, Math.max(wrappedRows, text.split("\n").length));
  const fieldId = useId();
  return (
    <div className={`terminal-input${dictation.shown ? " has-voice" : ""}`}>
      {/* the field's name in view, not only its placeholder: the same words as the key bar's mode key */}
      <label className="terminal-input-label" htmlFor={fieldId}>{t("Input line")}</label>
      <textarea
        ref={box}
        id={fieldId}
        className="terminal-input-text"
        rows={rows}
        value={text}
        maxLength={TERMINAL_LINE_LIMIT}
        onCompositionStart={() => { composing.current = true; compositions.current += 1; onComposing?.(true); }}
        onCompositionEnd={() => {
          composing.current = false;
          compositions.current += 1;
          onComposing?.(false);
          const current = attempt.current;
          if (current === null) return;
          if (current.timer !== null) clearTimeout(current.timer);
          current.timer = null;
          // WebKit updates the value with an input event after compositionend: send the committed word
          setTimeout(() => sendRef.current(true));
        }}
        placeholder={t("Type for the terminal…")}
        aria-label={t("Terminal input line")}
        enterKeyHint="send"
        // the keyboard's word strip too: Chrome on Android hands the keyboard NO_SUGGESTIONS only
        // for autocomplete="off", never for autocorrect or spellcheck
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          setNote(null);
          // an emptied line has nothing left for a waiting Send to send
          if (event.target.value.length === 0) clearPendingSend();
        }}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
      />
      {dictation.shown && <MicButton dictation={dictation} className="terminal-input-mic" />}
      <span className="terminal-input-actions">
        {/* Insert, apart from Send by its words, its outline and its name: the text goes to the
            prompt and stays there to edit. Each says what it does above its round target */}
        <button
          type="button"
          className="terminal-input-action terminal-input-insert"
          aria-label={t("Insert text without Enter")}
          title={t("Insert text without Enter")}
          disabled={!connected || sending || text.length === 0}
          onPointerDown={(event) => event.preventDefault()}
          onClick={insert}
        >
          <span className="terminal-input-caption" aria-hidden="true">{t("Insert text")}</span>
          <span className="terminal-input-face"><TextCursorInput aria-hidden="true" /></span>
        </button>
        <button
          type="button"
          className="terminal-input-action terminal-input-send"
          aria-label={t(text.length === 0 ? "Press Enter in the terminal" : "Send to the terminal")}
          title={t(text.length === 0 ? "Press Enter in the terminal" : "Send to the terminal")}
          disabled={!connected || sending}
          // the soft keyboard stays up for the next line
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => send()}
        >
          <span className="terminal-input-caption" aria-hidden="true">{t(text.length === 0 ? "Enter" : "Send")}</span>
          <span className="terminal-input-face">{text.length === 0 ? <CornerDownLeft aria-hidden="true" /> : <SendHorizontal aria-hidden="true" />}</span>
        </button>
      </span>
      {pending !== null && note === null && <p className="terminal-input-note is-pending" role="status">{pending}</p>}
      {note !== null && <p className="terminal-input-note" role="alert">{note}</p>}
      {dictation.shown && <VoiceRecordingPill dictation={dictation} align="end" />}
    </div>
  );
}

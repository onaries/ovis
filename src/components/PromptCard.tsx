import { useContext, useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronUp, FileText, Send } from "lucide-react";

import "./PromptCard.css";

import { ApiError } from "../lib/api.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import type { InteractivePrompt, PromptAnswer } from "../../shared/protocol.ts";
import { blocksStepNavigation, focusFollowsAnswer, pressOrigin, type TypedAnswer } from "../lib/promptAnswer.ts";
import { dismissKeyboardOn } from "../lib/keyboard.ts";
import { useT } from "../lib/i18n.ts";
import { userErrorMessage, type UserError } from "../lib/userError.ts";
import { OpenFileContext } from "../lib/filePaths.ts";

/**
 * One card is one occurrence of a prompt on one pane: its owner mounts a new card (a `key`) for
 * the next prompt, the same question asked again included. So the card's picks, text, scroll and
 * an answer still on its way never pass to another prompt, and an answer that comes back after
 * the card is gone reports nothing.
 */
export interface PromptCardProps {
  paneId: string;
  prompt: InteractivePrompt;
  onPromptChanged(): void;
  /** the answer went out; `toMessageBox`: the keyboard's focus was in the card, which is about to go, nothing else has taken it since, and the press was a key or a mouse, not a tap */
  onAnswered(toMessageBox: boolean): void;
  /** an option picked by a typed message, sent only on Confirm */
  typedAnswer?: TypedAnswer | null;
  onTypedAnswerDone?(): void;
  /** the last reads of the screen failed: the question shown may have changed since (an answer is still checked, 409 prompt_changed) */
  stale?: boolean;
}

export function PromptCard({ paneId, prompt, onPromptChanged, onAnswered, typedAnswer = null, onTypedAnswerDone, stale = false }: PromptCardProps) {
  const t = useT();
  const { answerPanePrompt } = useMachineApi();
  const [selected, setSelected] = useState<Set<number>>(() => {
    if (prompt.default_option_indices && prompt.default_option_indices.length > 0) {
      return new Set(prompt.default_option_indices);
    }
    if (prompt.default_option_index !== undefined && prompt.default_option_index !== null) {
      return new Set([prompt.default_option_index]);
    }
    return new Set();
  });
  const [custom, setCustom] = useState(() => prompt.default_custom_text ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<UserError | null>(null);
  // folded to its header, to read the transcript under it; the question still waits, so the card
  // stays. A typed answer to confirm opens it, and the next prompt's card starts open
  const [foldedByUser, setFoldedByUser] = useState(false);
  const folded = foldedByUser && typedAnswer?.option_index === undefined;
  const cardRef = useRef<HTMLElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  // the control Enter or Space last went down on: the click that follows on it is that key's
  const keyed = useRef<EventTarget | null>(null);
  // and the button a pointer last went down on, with what it was: a click can misname its pointer
  const down = useRef<{ target: EventTarget; pointerType: string } | null>(null);
  // false once the card is gone: its prompt was replaced, or its pane left
  const shown = useRef(false);
  useEffect(() => {
    shown.current = true;
    return () => { shown.current = false; };
  }, []);

  // the question to confirm stays on the card's fold (PromptCard.css); a card scrolled past it
  // comes back to it, and nothing outside the card moves
  useEffect(() => {
    confirmRef.current?.scrollIntoView({ block: "nearest" });
  }, [typedAnswer]);

  // The card stands where the transcript was on a short phone: a tap on its text, or a drag down
  // it once it is at its top, puts the keyboard away as on the transcript (lib/keyboard.ts).
  // Its buttons, boxes and field do what they do.
  useEffect(() => {
    const node = cardRef.current;
    return node === null ? undefined : dismissKeyboardOn(node, { atTopOnly: true });
  }, []);

  /**
   * Sends one answer. `press` is the click that asked for it (none for a key in the card's field).
   * Resolves to whether this card is still the one shown: an answer that comes back after another
   * prompt took its place, or after its pane was left, changes nothing there.
   */
  const answer = async (choice: Omit<PromptAnswer, "pane_id" | "prompt_id">, press?: { nativeEvent: Event; currentTarget: EventTarget }): Promise<boolean> => {
    // Native OpenCode multiselect fields accept checks and a custom entry in the same array.
    // Both buttons and Enter submit the whole field, including edits restored by Back.
    if (prompt.agent === "opencode" && !prompt.fallback && prompt.multi_select && (choice.option_indices !== undefined || choice.custom_text !== undefined)) {
      choice = {
        option_indices: [...selected].sort((a, b) => a - b),
        ...(custom.trim() ? { custom_text: custom.trim() } : {}),
      };
    }
    // read now: the pressed button is disabled while the answer is on its way, and loses the focus
    const fromCard = cardRef.current?.contains(document.activeElement) === true;
    const click = press?.nativeEvent as Partial<PointerEvent> | undefined;
    const origin = pressOrigin(press === undefined ? undefined : { pointerType: click?.pointerType, downType: down.current?.target === press.currentTarget ? down.current.pointerType : undefined, detail: click?.detail, keyed: keyed.current === press.currentTarget });
    keyed.current = null;
    down.current = null;
    // the device's own pointer, asked only for a press that does not say what made it
    const coarse = window.matchMedia?.("(pointer: coarse)").matches === true;
    setPending(true);
    setError(null);
    try {
      await answerPanePrompt({ pane_id: paneId, prompt_id: prompt.id, ...choice });
      if (!shown.current) return false;
      // and read again: the answer took a moment, and the user may have gone on to something else
      const card = cardRef.current;
      const active = document.activeElement;
      onAnswered(focusFollowsAnswer({ fromCard, origin, coarse, cardMounted: card !== null, inCard: card?.contains(active) === true, onPage: active === null || active === document.body }));
    } catch (cause) {
      if (!shown.current) return false;
      // a card read before the question moved on: refused as changed (409), or as an answer it no longer fits (400).
      // The note stays until the card is replaced or answered again, so the button never looks dead
      if (cause instanceof ApiError && cause.code === "reply_unconfirmed") {
        setError({ message: t("OpenCode did not confirm the answer. Check the question before sending again."), detail: null });
        onPromptChanged();
      } else if (cause instanceof ApiError && ((cause.status === 409 && cause.code === "prompt_changed") || (cause.status === 400 && cause.code === "invalid_answer"))) {
        setError({ message: t("The question on screen changed; check it and answer again."), detail: null });
        onPromptChanged();
      } else {
        setError(userErrorMessage(cause));
      }
    }
    setPending(false);
    return true;
  };

  const toggle = (index: number): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  };

  const customLabelId = useId();
  // Claude renders the menu's own pick as "Redis (Recommended)": a tag reads better than the suffix
  const labelOf = (label: string): { text: string; recommended: boolean } => {
    const text = label.replace(/\s*\(recommended\)$/i, "");
    return { text, recommended: text !== label };
  };
  const hasChoices = prompt.options.some((_, index) => index !== prompt.custom_option_index);
  const openFile = useContext(OpenFileContext);
  const planFile = prompt.plan_file;
  const navigationBlocked = blocksStepNavigation(prompt, selected, custom);

  return (
    <section className={`prompt-card${folded ? " is-folded" : ""}`} ref={cardRef} role="region" aria-label={t("Agent is asking")}
      onKeyDown={(event) => { down.current = null; keyed.current = event.key === "Enter" || event.key === " " ? event.target : null; }}
      onPointerDown={(event) => {
        keyed.current = null;
        const button = (event.target as Element).closest("button");
        down.current = button === null ? null : { target: button, pointerType: event.pointerType };
      }}>
      <header className="prompt-card-header">
        {prompt.can_step_back && (
          <button
            type="button"
            className="btn btn-ghost prompt-card-back"
            disabled={pending || navigationBlocked}
            aria-label={t("Back")}
            title={t("Back")}
            onClick={(event) => void answer({ step_back: true, draft: { option_indices: [...selected], custom_text: custom } }, event)}
          >
            <ArrowLeft aria-hidden="true" />
            <span>{t("Back")}</span>
          </button>
        )}
        {/* read, not drawn: the title is the card's one red */}
        <span className="visually-hidden">{t("input needed")}</span>
        <h2>{prompt.title}</h2>
        {/* the card shows a plan in its short box; the file viewer draws the whole of it as Markdown */}
        {planFile && openFile && (
          <button type="button" className="btn btn-ghost prompt-card-plan-file" onClick={() => openFile(planFile)}>
            <FileText aria-hidden="true" />{t("View plan")}
          </button>
        )}
        {/* a typed answer waiting for Confirm keeps the card open, so the fold has nothing to do then */}
        <button type="button" className="prompt-card-fold" disabled={typedAnswer?.option_index !== undefined} aria-expanded={!folded} aria-label={t(folded ? "Expand question" : "Collapse question")} title={t(folded ? "Expand question" : "Collapse question")} onClick={() => setFoldedByUser(!folded)}>
          {folded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </button>
      </header>
      {/* a form of several questions (omo): each one, answered or not, and the one asked now */}
      {prompt.steps && (
        <ol className="prompt-card-steps" aria-label={t("Questions")}>
          {prompt.steps.map((step, index) => {
            const isClickable = !step.current && (step.can_navigate || step.answered && prompt.can_step_back);
            return (
              <li
                key={index}
                className={`prompt-card-step${step.answered ? " is-answered" : ""}${step.current ? " is-current" : ""}${isClickable ? " is-clickable" : ""}`}
                aria-current={step.current ? "step" : undefined}
              >
                {isClickable ? (
                  <button
                    type="button"
                    className="prompt-card-step-button"
                    disabled={pending || navigationBlocked}
                    aria-label={step.label}
                    title={step.can_navigate ? step.label : t("Back")}
                    onClick={(event) => void answer({ step_index: index, draft: { option_indices: [...selected], custom_text: custom } }, event)}
                  >
                    <span className="prompt-card-step-mark" aria-hidden="true">{step.answered ? <Check /> : index + 1}</span>
                    <span className="prompt-card-step-label">{step.label}</span>
                    {step.answered && <span className="visually-hidden">{t("(answered)")}</span>}
                  </button>
                ) : (
                  <>
                    <span className="prompt-card-step-mark" aria-hidden="true">{step.answered ? <Check /> : index + 1}</span>
                    <span className="prompt-card-step-label">{step.label}</span>
                    {step.answered && <span className="visually-hidden">{t("(answered)")}</span>}
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {navigationBlocked && <p className="prompt-card-hint">{t("Submit or clear edits before switching questions.")}</p>}
      {/* a Claude approval's heading is its question too: said once */}
      {prompt.question !== prompt.title && <p className="prompt-card-question">{prompt.question}</p>}
      {prompt.queued && (
        <p className="prompt-card-hint">
          {prompt.queued === "open"
            ? t("Codex keeps working meanwhile. Answer here; the question holds the terminal's input until it is answered or closed.")
            : t("Codex keeps working meanwhile. Answer here; the message box still talks to Codex.")}
        </p>
      )}
      {/* the reference text (a command, a plan, a diff) is the one part that gives way when the card is short */}
      {/* a review's answers (Claude, omp): each question over what was picked for it, read as prose */}
      {prompt.answers && (
        <dl className="prompt-card-answers">
          {prompt.answers.map((item, index) => {
            const answer = item.answer === null ? null : labelOf(item.answer);
            return (
              <div key={index} className="prompt-card-answer">
                {item.question !== null && <dt>{item.question}</dt>}
                <dd className={answer === null ? "is-empty" : undefined}>
                  {answer === null ? t("Not answered") : <>{answer.text}{answer.recommended && <> <span className="prompt-card-tag">{t("Recommended")}</span></>}</>}
                </dd>
                {item.note !== undefined && <dd className="prompt-card-answer-note">{t("Note: {note}", { note: item.note })}</dd>}
              </div>
            );
          })}
        </dl>
      )}
      {prompt.body !== null && prompt.body.length > 0 && <pre className={`prompt-card-body${prompt.body.includes("\n") ? "" : " is-line"}`}>{prompt.body}</pre>}
      {hasChoices && (
        /* busy on the options alone, never on the card: a live region inside an aria-busy subtree is not
           read (Chromium), and the status line below has to be */
        <div className="prompt-card-options" role={prompt.multi_select ? "group" : undefined} aria-label={prompt.multi_select ? prompt.question : undefined} aria-busy={pending}>
          {prompt.options.map((option, index) => {
            if (index === prompt.custom_option_index) return null;
            const { text, recommended } = labelOf(option.label);
            const content = (
              <span className="prompt-card-option-text">
                <span className="prompt-card-option-label">{text}{recommended && <> <span className="prompt-card-tag">{t("Recommended")}</span></>}</span>
                {option.description !== null && <span className="prompt-card-option-description">{option.description}</span>}
              </span>
            );
            // the key the user can type, drawn as a keycap; the option's name keeps the menu's "1."
            const number = <span className="prompt-card-number"><span aria-hidden="true">{index + 1}</span><span className="visually-hidden">{index + 1}.</span></span>;
            const described = option.description !== null ? " has-description" : "";
            if (prompt.multi_select) {
              const checked = selected.has(index);
              return (
                <label className={`prompt-card-option${described}${checked ? " is-checked" : ""}`} key={index}>
                  <input type="checkbox" checked={checked} disabled={pending} onChange={() => toggle(index)} />
                  {number} {content}
                </label>
              );
            }
            const isSelected = prompt.default_option_index === index;
            return (
              <button key={index} type="button" className={`prompt-card-option${described}${typedAnswer?.option_index === index ? " is-typed" : ""}${isSelected ? " is-selected" : ""}`} disabled={pending} onClick={(event) => void answer({ option_index: index }, event)}>
                {number} {content}
              </button>
            );
          })}
        </div>
      )}
      {prompt.multi_select && (
        <button type="button" className={`btn${selected.size > 0 ? " btn-primary" : ""} prompt-card-submit`} disabled={pending || (selected.size === 0 && !prompt.optional && !(prompt.agent === "opencode" && custom.trim()))} onClick={(event) => void answer({ option_indices: [...selected].sort((a, b) => a - b) }, event)}>
          {selected.size > 0 ? t("Submit ({n})", { n: selected.size }) : t("Submit")}
        </button>
      )}
      {prompt.custom_option_index !== null && (
        <div className="prompt-card-custom">
          {hasChoices && <span className="prompt-card-custom-label" id={customLabelId}>{prompt.agent === "opencode" && prompt.multi_select ? t("Custom answer") : t("Or type your own answer")}</span>}
          <div className="prompt-card-custom-row">
            <input className="input" value={custom} disabled={pending} placeholder={prompt.options[prompt.custom_option_index]?.label ?? t("Type an answer")} aria-label={hasChoices ? undefined : t("Custom answer")} aria-labelledby={hasChoices ? customLabelId : undefined} onChange={(event) => setCustom(event.currentTarget.value)} onKeyDown={(event) => {
              // an IME's Enter commits the candidate; WebKit can send it after compositionend, as key code 229
              if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && custom.trim().length > 0) void answer({ custom_text: custom.trim() });
            }} />
            <button type="button" className={`btn${custom.trim().length > 0 ? " btn-primary" : ""}`} disabled={pending || custom.trim().length === 0} onClick={(event) => void answer({ custom_text: custom.trim() }, event)}>
              <Send aria-hidden="true" /> {t("Send")}
            </button>
          </div>
        </div>
      )}
      {prompt.optional && !prompt.multi_select && (
        <button type="button" className="btn prompt-card-skip" disabled={pending} onClick={(event) => void answer({ custom_text: "" }, event)}>
          {t("Skip question")}
        </button>
      )}
      {typedAnswer?.option_index !== undefined && (
        <div className="prompt-card-confirm" role="alert" ref={confirmRef}>
          {/* an option's label can run to pages (a review to approve): the question shows two lines
              of it and scrolls in itself, and the two buttons stay whole, on one line */}
          <span className="prompt-card-confirm-text">{t("Send {answer}?", { answer: `${typedAnswer.option_index + 1}. ${prompt.options[typedAnswer.option_index]?.label ?? ""}` })}</span>
          <span className="prompt-card-confirm-actions">
            <button type="button" className="btn btn-primary" disabled={pending} onClick={(event) => void answer(typedAnswer, event).then((current) => { if (current) onTypedAnswerDone?.(); })}>{t("Confirm")}</button>
            <button type="button" className="btn" disabled={pending} onClick={() => onTypedAnswerDone?.()}>{t("Cancel")}</button>
          </span>
        </div>
      )}
      {/* in the card from its first render, clipped while empty (never display: none): a live region that
          appears together with its words is not read; one that is there and gets them is */}
      <p className={pending || stale ? "prompt-card-status" : "visually-hidden"} role="status">{pending ? t("Sending your answer…") : stale ? t("Not updated: the question on screen may have changed.") : null}</p>
      {error !== null && <p className="prompt-card-error" role="alert">{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}</p>}
    </section>
  );
}

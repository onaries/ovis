/**
 * What each waiting agent of the inbox asks (components/AgentInbox.tsx): its prompt card read once per
 * wait and each time the list is shown, through the read-only GET /api/pane/prompt, a few at a time.
 * Nothing is answered from here.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { InteractivePrompt } from "../../shared/protocol.ts";
import { inboxKey, inboxStatus, questionWords } from "./agentInbox.ts";
import { agentGroup, type AgentRow } from "./agentRoster.ts";
import { fetchPanePromptState } from "./api.ts";
import { translate, type Language } from "./i18n.ts";
import { promptWords } from "./promptText.ts";
import { useSettings } from "./settings.ts";
import type { SidebarActivity } from "./sidebarActivity.tsx";

/** How long after an empty answer the card is asked for once more: the state push can precede the drawn card. */
export const QUESTION_RETRY_MS = 1500;
/** Prompt reads in flight at once, so a list of waiting agents never fans out. */
export const QUESTION_READS_AT_ONCE = 2;

/**
 * A waiting row whose question is read: `seq` is its state counter, a new wait reads it again; `lifetime` is its PC's
 * herdr lifetime, as a replaced herdr can reuse a pane id and counter.
 */
export interface QuestionTarget { key: string; machineId: string; paneId: string; seq: number; lifetime: string }

/** The rows of a PC in reach that wait for the user and whose agent reported no words of its own. */
export function questionTargets(rows: readonly AgentRow[], activity: SidebarActivity): QuestionTarget[] {
  return rows.flatMap((row) => {
    const pane = row.entry.pane;
    if (agentGroup(inboxStatus(row, activity)) !== "blocked" || pane.agent_kind || pane.agent_message?.trim()) return [];
    return [{
      key: inboxKey(row), machineId: row.machine.id, paneId: pane.pane_id, seq: activity.seqs(row.machine.id).get(pane.pane_id) ?? 0,
      lifetime: row.machine.snapshot?.herdr_lifetime ?? "",
    }];
  });
}

type Read = (paneId: string, machineId: string) => Promise<{ prompt: InteractivePrompt | null }>;
type Words = (prompt: InteractivePrompt, language: Language) => string;
type Wait = (run: () => void, ms: number) => () => void;

/** A target read in one interface language: a new seq, lifetime or language reads it again. */
interface Ask extends QuestionTarget { language: Language }

const NO_TEXTS: ReadonlyMap<string, string> = new Map();
/** what a target's words are read for: its herdr lifetime and seq */
const waitOf = (target: QuestionTarget): string => `${target.lifetime}\n${target.seq}`;
interface ReadFor { lifetime: string; seq: number }
/** words read for this wait: the same seq, under the same herdr, or one whose lifetime was unproven ("") on either side */
const sameWait = (read: ReadFor | undefined, target: QuestionTarget): boolean => read !== undefined && read.seq === target.seq
  && (read.lifetime === target.lifetime || read.lifetime === "" || target.lifetime === "");
const readOf = (ask: Ask): string => `${ask.key}\n${waitOf(ask)}\n${ask.language}`;

/**
 * Each target's question, read once per key, seq and language, at most QUESTION_READS_AT_ONCE at a time, and
 * once more each time the list is shown (`shownAgain`): a seq is no prompt's identity (a bridge without one
 * gives every wait 0, and two prompts can share a state), so the words kept from before are checked. The reader
 * lives as long as the page: the words stay across mounts, shown until the new answer lands, and a read still
 * on its way is not started twice. A read gets two attempts: an empty or failed answer is asked once more
 * after QUESTION_RETRY_MS, cancelled when the target moves on or leaves; a second empty answer removes the words. A target's words
 * belong to the seq they were read for and go when it moves on or leaves. An answer for a target gone or
 * moved on since is dropped.
 */
export class QuestionReads {
  private readonly listeners = new Set<() => void>();
  private current: ReadonlyMap<string, string> = NO_TEXTS;
  /** the lifetime and seq each stored text was read for */
  private readonly readFor = new Map<string, ReadFor>();
  private targets = new Map<string, Ask>();
  /** the reads started, queued or done, and those given their second attempt */
  private readonly started = new Set<string>();
  private readonly retried = new Set<string>();
  private readonly waits = new Map<string, () => void>();
  /** the reads whose answer is on its way, and those of them a showing found so (read once more when they land) */
  private readonly reading = new Set<string>();
  private readonly followUps = new Set<string>();
  private queue: Ask[] = [];
  private inFlight = 0;

  constructor(private readonly read: Read, private readonly words: Words,
    private readonly wait: Wait = (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer); }) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** The same object until a text is added, replaced or removed. */
  texts = (): ReadonlyMap<string, string> => this.current;

  /** The words read for this target's own seq and lifetime: none while its new wait is not read yet. */
  wordsFor(target: QuestionTarget): string | undefined {
    return sameWait(this.readFor.get(target.key), target) ? this.current.get(target.key) : undefined;
  }

  /**
   * The list is shown again: every read done may be made once more at the next sync, its attempts afresh; one queued
   * or waiting its retry is left as it is, and one in flight is read once more when it lands (its answer may be of the
   * question before).
   */
  shownAgain(): void {
    for (const read of this.reading) this.followUps.add(read);
    const busy = new Set([...this.reading, ...this.waits.keys(), ...this.queue.map(readOf)]);
    for (const read of [...this.started]) if (!busy.has(read)) this.started.delete(read);
    for (const read of [...this.retried]) if (!busy.has(read)) this.retried.delete(read);
  }

  sync(targets: readonly QuestionTarget[], language: Language = "en"): void {
    const asks = targets.map((target): Ask => ({ ...target, language }));
    this.targets = new Map(asks.map((ask) => [ask.key, ask]));
    const live = new Set(asks.map(readOf));
    for (const read of new Set([...this.started, ...this.retried])) {
      if (live.has(read)) continue;
      this.started.delete(read);
      this.retried.delete(read);
      this.waits.get(read)?.();
      this.waits.delete(read);
    }
    this.queue = this.queue.filter((ask) => this.isCurrent(ask));
    const stale = [...this.current.keys()].filter((key) => { const now = this.targets.get(key); return now === undefined || !sameWait(this.readFor.get(key), now); });
    if (stale.length > 0) this.change((texts) => { for (const key of stale) { texts.delete(key); this.readFor.delete(key); } });
    for (const ask of asks) {
      const read = readOf(ask);
      if (this.started.has(read)) continue;
      this.started.add(read);
      this.queue.push(ask);
    }
    this.pump();
  }

  private isCurrent(ask: Ask): boolean {
    const now = this.targets.get(ask.key);
    return now?.seq === ask.seq && now.lifetime === ask.lifetime && now.language === ask.language;
  }

  private change(edit: (texts: Map<string, string>) => void): void {
    const next = new Map(this.current);
    edit(next);
    this.current = next;
    for (const listener of [...this.listeners]) listener();
  }

  private pump(): void {
    while (this.inFlight < QUESTION_READS_AT_ONCE && this.queue.length > 0) {
      const ask = this.queue.shift()!;
      if (this.isCurrent(ask)) this.start(ask);
    }
  }

  private start(ask: Ask): void {
    this.inFlight++;
    const read = readOf(ask);
    this.reading.add(read);
    this.read(ask.paneId, ask.machineId).then(({ prompt }) => {
      this.inFlight--;
      this.reading.delete(read);
      try { this.answered(ask, prompt); } catch { this.failed(ask); }
      this.followUp(ask);
      this.pump();
    }, () => {
      this.inFlight--;
      this.reading.delete(read);
      this.failed(ask);
      this.followUp(ask);
      this.pump();
    });
  }

  /** One more read of a target a showing found in flight, its attempts afresh, unless its retry already reads it again. */
  private followUp(ask: Ask): void {
    const read = readOf(ask);
    if (!this.followUps.delete(read) || !this.isCurrent(ask) || this.waits.has(read)) return;
    this.retried.delete(read);
    this.queue.push(ask);
  }

  private answered(ask: Ask, prompt: InteractivePrompt | null): void {
    if (!this.isCurrent(ask)) return;
    if (prompt !== null) {
      const words = this.words(prompt, ask.language);
      this.readFor.set(ask.key, { lifetime: ask.lifetime, seq: ask.seq });
      if (this.current.get(ask.key) !== words) this.change((texts) => { texts.set(ask.key, words); });
      return;
    }
    // asked twice and no question: the words read before (a showing earlier, another language) are gone
    if (!this.retry(ask) && this.current.has(ask.key)) this.change((texts) => { texts.delete(ask.key); this.readFor.delete(ask.key); });
  }

  /** a failed read is tried once more as an empty one is, without waiting for the list to change */
  private failed(ask: Ask): void {
    if (this.isCurrent(ask)) this.retry(ask);
  }

  /** Asks again after QUESTION_RETRY_MS, once: false when this was the second attempt. */
  private retry(ask: Ask): boolean {
    const read = readOf(ask);
    if (this.retried.has(read)) return false;
    this.retried.add(read);
    this.waits.set(read, this.wait(() => {
      this.waits.delete(read);
      if (!this.isCurrent(ask)) return;
      this.queue.push(ask);
      this.pump();
    }, QUESTION_RETRY_MS));
    return true;
  }
}

/**
 * The page's reader: made once beside the list's other state (lib/useInbox.ts), so it outlives each mount of the list.
 * `wait` is the retry's timer (a test passes its own).
 */
export const newQuestionReads = (wait?: Wait): QuestionReads =>
  new QuestionReads(fetchPanePromptState, (prompt, language) => questionWords(promptWords(prompt, (key, vars) => translate(language, key, vars))), wait);

/** Each waiting target's question by its key, from the page's reader, in the interface's language. */
export function useInboxQuestions(reads: QuestionReads, targets: readonly QuestionTarget[]): ReadonlyMap<string, string> {
  const { resolvedLanguage } = useSettings();
  const targetsRef = useRef(targets); targetsRef.current = targets;
  const signature = targets.map((target) => `${target.key}:${target.seq}:${target.lifetime}`).join("\n");
  // each mount of the list reads every waiting row's question once more, before its first sync
  useEffect(() => { reads.shownAgain(); }, [reads]);
  useEffect(() => { reads.sync(targetsRef.current, resolvedLanguage); }, [reads, signature, resolvedLanguage]);
  const texts = useSyncExternalStore(reads.subscribe, reads.texts, reads.texts);
  // filtered here too, so a list mounted again never draws the words of a wait its row has left
  return useMemo(() => new Map(targetsRef.current.flatMap((target) => {
    const words = reads.wordsFor(target);
    return words === undefined ? [] : [[target.key, words] as const];
  })), [reads, texts, signature]);
}

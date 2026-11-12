/**
 * What each waiting agent of the inbox asks (components/AgentInbox.tsx): its prompt card read once per
 * wait through the read-only GET /api/pane/prompt, a few at a time. Nothing is answered from here.
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

/** A waiting row whose question is read: `seq` is its state counter, a new wait reads it again. */
export interface QuestionTarget { key: string; machineId: string; paneId: string; seq: number }

/** The rows of a PC in reach that wait for the user and whose agent reported no words of its own. */
export function questionTargets(rows: readonly AgentRow[], activity: SidebarActivity): QuestionTarget[] {
  return rows.flatMap((row) => {
    const pane = row.entry.pane;
    if (agentGroup(inboxStatus(row, activity)) !== "blocked" || pane.agent_kind || pane.agent_message?.trim()) return [];
    return [{ key: inboxKey(row), machineId: row.machine.id, paneId: pane.pane_id, seq: activity.seqs(row.machine.id).get(pane.pane_id) ?? 0 }];
  });
}

type Read = (paneId: string, machineId: string) => Promise<{ prompt: InteractivePrompt | null }>;
type Words = (prompt: InteractivePrompt, language: Language) => string;
type Wait = (run: () => void, ms: number) => () => void;

/** A target read in one interface language: a new seq or another language reads it again. */
interface Ask extends QuestionTarget { language: Language }

const NO_TEXTS: ReadonlyMap<string, string> = new Map();
const readOf = (ask: Ask): string => `${ask.key}\n${ask.seq}\n${ask.language}`;

/**
 * Each target's question, read once per key, seq and language, at most QUESTION_READS_AT_ONCE at a time; it
 * lives as long as the page, so a list mounted again reads nothing it read before. A read gets two attempts:
 * an empty answer is asked once more after QUESTION_RETRY_MS, a failed one at the next sync. A target's words
 * belong to the seq they were read for and go when it moves on or leaves. An answer for a target gone or
 * moved on since is dropped.
 */
export class QuestionReads {
  private readonly listeners = new Set<() => void>();
  private current: ReadonlyMap<string, string> = NO_TEXTS;
  /** the seq each stored text was read for */
  private readonly readFor = new Map<string, number>();
  private targets = new Map<string, Ask>();
  /** the reads started, queued or done, and those given their second attempt */
  private readonly started = new Set<string>();
  private readonly retried = new Set<string>();
  private readonly waits = new Map<string, () => void>();
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

  /** The words read for this target's own seq: none while its new wait is not read yet. */
  wordsFor(target: QuestionTarget): string | undefined {
    return this.readFor.get(target.key) === target.seq ? this.current.get(target.key) : undefined;
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
    const stale = [...this.current.keys()].filter((key) => this.targets.get(key)?.seq !== this.readFor.get(key));
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
    return now?.seq === ask.seq && now.language === ask.language;
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
    this.read(ask.paneId, ask.machineId).then(({ prompt }) => {
      this.inFlight--;
      try { this.answered(ask, prompt); } catch { this.failed(ask); }
      this.pump();
    }, () => {
      this.inFlight--;
      this.failed(ask);
      this.pump();
    });
  }

  private answered(ask: Ask, prompt: InteractivePrompt | null): void {
    if (!this.isCurrent(ask)) return;
    if (prompt !== null) {
      const words = this.words(prompt, ask.language);
      this.readFor.set(ask.key, ask.seq);
      if (this.current.get(ask.key) !== words) this.change((texts) => { texts.set(ask.key, words); });
      return;
    }
    const read = readOf(ask);
    if (this.retried.has(read)) return;
    this.retried.add(read);
    this.waits.set(read, this.wait(() => {
      this.waits.delete(read);
      if (!this.isCurrent(ask)) return;
      this.queue.push(ask);
      this.pump();
    }, QUESTION_RETRY_MS));
  }

  /** a failed read is started again at the next sync, once */
  private failed(ask: Ask): void {
    if (!this.isCurrent(ask)) return;
    const read = readOf(ask);
    if (this.retried.has(read)) return;
    this.retried.add(read);
    this.started.delete(read);
  }
}

/** The page's reader: made once beside the list's other state (lib/useInbox.ts), so it outlives each mount of the list. */
export const newQuestionReads = (): QuestionReads =>
  new QuestionReads(fetchPanePromptState, (prompt, language) => questionWords(promptWords(prompt, (key, vars) => translate(language, key, vars))));

/** Each waiting target's question by its key, from the page's reader, in the interface's language. */
export function useInboxQuestions(reads: QuestionReads, targets: readonly QuestionTarget[]): ReadonlyMap<string, string> {
  const { resolvedLanguage } = useSettings();
  const targetsRef = useRef(targets); targetsRef.current = targets;
  const signature = targets.map((target) => `${target.key}:${target.seq}`).join("\n");
  useEffect(() => { reads.sync(targetsRef.current, resolvedLanguage); }, [reads, signature, resolvedLanguage]);
  const texts = useSyncExternalStore(reads.subscribe, reads.texts, reads.texts);
  // filtered here too, so a list mounted again never draws the words of a wait its row has left
  return useMemo(() => new Map(targetsRef.current.flatMap((target) => {
    const words = reads.wordsFor(target);
    return words === undefined ? [] : [[target.key, words] as const];
  })), [reads, texts, signature]);
}

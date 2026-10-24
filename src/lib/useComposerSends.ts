import { useCallback, type MutableRefObject } from "react";
import { ApiError } from "./api.ts";
import { answerFromText, answerRefusal, needsConfirmation } from "./promptAnswer.ts";
import { composerDelivery, pendingActionUncertain, submitNotTyped, submitRefusal, type DraftRefusal } from "./compose.ts";
import type { PaneSubmitRetention } from "./paneSubmitRetention.ts";
import { pendingMessages } from "./pendingMessages.ts";
import type { AgentStatus, InteractivePrompt, PromptAnswer } from "../../shared/protocol.ts";
import type { HerdrSocket, SubmitDelivery, SubmitResult } from "./ws.ts";
import { plainError } from "./paneTerminalShared.ts";
import type { Translate } from "./i18n.ts";
import type { MachineSession } from "./machineSession.ts";

export interface ComposerSendsDeps {
  agent: string | null;
  agentStatus: AgentStatus | undefined;
  answerPanePrompt: (answer: { pane_id: string; prompt_id: string }) => Promise<unknown>;
  answering: InteractivePrompt | null;
  draftHeldForRef: MutableRefObject<string | null>;
  ended: boolean;
  heldByOpenQueue: boolean;
  heldRef: MutableRefObject<boolean>;
  inputRowNow: () => string | null;
  knownOutcomes: (pane: string | null) => readonly string[] | null;
  observeRef: MutableRefObject<boolean>;
  paneId: string | null;
  paneRef: MutableRefObject<string | null>;
  pendingScopeRef: MutableRefObject<string | null>;
  /** the chat's navigation generation, read as a message goes out (ChatView `navigation`) */
  chatNavigation: MutableRefObject<number>;
  /** advanced once this browser's own message from the box was accepted at once (ChatView `localSend`) */
  setChatLocalSend: (update: (current: { key: number; navigationGeneration: number }) => { key: number; navigationGeneration: number }) => void;
  sessionRef: MutableRefObject<MachineSession | null>;
  queueOwner: string | null;
  queueStore: unknown;
  machineId: string;
  secretRef: MutableRefObject<string | null>;
  setPendingAnswer: (answer: { pane: string; promptId: string; answer: Pick<PromptAnswer, "option_index" | "option_indices" | "custom_text"> } | null) => void;
  setPromptRefresh: (update: (key: number) => number) => void;
  settings: { autoSendQueued: boolean };
  showSentCommand: (pane: string, text: string, known: readonly string[] | null, seen: boolean) => void;
  socketRef: MutableRefObject<HerdrSocket | null>;
  stillOpenNote: (open: { pane: string; agent: string; command: string; named: boolean; history: string | undefined }) => string;
  stillOpenNotedRef: MutableRefObject<boolean>;
  stillOpenRef: MutableRefObject<{ pane: string; agent: string; command: string; named: boolean; history: string | undefined } | null>;
  submitComposerMessage: (text: string, delivery: SubmitDelivery, clearDraft?: string, sendAnyway?: boolean, pendingId?: string, resendGeneration?: number) => Promise<SubmitResult> | null;
  submitRetention: PaneSubmitRetention | null;
  t: Translate;
}

export function useComposerSends(deps: ComposerSendsDeps) {
  const { agent, agentStatus, answerPanePrompt, answering, chatNavigation, draftHeldForRef, ended, heldByOpenQueue, heldRef, inputRowNow, knownOutcomes, observeRef, paneId, paneRef, pendingScopeRef, queueOwner, queueStore, machineId, secretRef, sessionRef, setChatLocalSend, setPendingAnswer, setPromptRefresh, settings, showSentCommand, socketRef, stillOpenNote, stillOpenNotedRef, stillOpenRef, submitComposerMessage, submitRetention, t } = deps;
  const composerSend = useCallback(
    (text: string, clearDraft?: string, sendAnyway = false): boolean | string | DraftRefusal | Promise<boolean | string | DraftRefusal> => {
      const pane = paneRef.current;
      // Codex's queue open in the terminal holds the input: a message would become the answer
      if (pane !== null && heldByOpenQueue) {
        return t("Codex has a question open in the terminal: answer it above, or close it there (alt+↓) to message Codex.");
      }
      if (pane !== null && answering !== null) {
        // never typed into the agent's menu: only as one of its options, or its own reply row
        const choice = answerFromText(answering, text);
        if (choice === null) return answerRefusal(answering);
        if (needsConfirmation(answering, choice)) {
          setPendingAnswer({ pane, promptId: answering.id, answer: choice });
          return true;
        }
        setPendingAnswer(null);
        return answerPanePrompt({ pane_id: pane, prompt_id: answering.id, ...choice }).then(
          () => { setPromptRefresh((key) => key + 1); return true; },
          (cause: unknown) => {
            setPromptRefresh((key) => key + 1);
            if (cause instanceof ApiError && cause.code === "reply_unconfirmed") return t("OpenCode did not confirm the answer. Check the question before sending again.");
            return cause instanceof ApiError && cause.status === 409 ? t("The question on screen changed; check it and answer again.") : plainError(cause);
          },
        );
      }
      if (!socketRef.current?.connected || heldRef.current || secretRef.current !== null) return false;
      // A screen a peek left open in the terminal would take the message: Send says so and keeps it,
      // and the note's Send anyway sends it once (the recognizer may be wrong), as a plain send: it
      // answers this guard, never a box the server showed
      const notedStillOpen = stillOpenNotedRef.current;
      stillOpenNotedRef.current = false;
      const open = stillOpenRef.current;
      if (sendAnyway && notedStillOpen) sendAnyway = false;
      else if (!sendAnyway && open !== null && open.pane === pane) {
        stillOpenNotedRef.current = true;
        return { note: stillOpenNote(open), anyway: true, plain: true };
      }
      // an older bridge is told apart by the socket, once this connection's snapshot has said what it supports.
      // A draft is cleared only by a send at once: one that waits its turn is checked when it goes
      // with automatic sending off, a follow-up waits for Send now; the socket queues it on a PC too old to hold one
      const queued = composerDelivery(agent, agentStatus);
      const delivery: SubmitDelivery = queued === "queue" && (agent === "omo" || !settings.autoSendQueued) ? "hold" : queued;
      // Send anyway answered a box seen at once: an agent that started working since would queue it unchecked
      if (sendAnyway && delivery !== "immediate") return t("Not sent: the agent started working since. Check the terminal, then send again.");
      const known = knownOutcomes(pane);
      const seen = inputRowNow() === "ready";
      // before the receipt is awaited: navigation while it is on its way cancels the follow
      const navigation = chatNavigation.current;
      const socket = socketRef.current, session = sessionRef.current;
      const result = submitComposerMessage(text, delivery, delivery === "immediate" ? clearDraft : undefined, sendAnyway);
      return result === null ? false : result.then((answer) => {
        if (!answer.ok) return submitRefusal(answer.code, answer.message, answer.draft, answer.box, agent);
        // only a receipt that says the pane took it at once, on the connection and pane it left from
        if (delivery === "immediate" && answer.pending === undefined && !answer.unconfirmed
          && paneRef.current === pane && socketRef.current === socket && sessionRef.current === session) {
          setChatLocalSend((current) => ({ key: current.key + 1, navigationGeneration: navigation }));
        }
        if (pane !== null && delivery === "immediate" && answer.pending === undefined && !answer.unconfirmed) showSentCommand(pane, text, known, seen);
        return true;
      });
    },
    [agent, agentStatus, answerPanePrompt, answering, heldByOpenQueue, submitComposerMessage, queueStore, machineId, settings.autoSendQueued, showSentCommand, inputRowNow, stillOpenNote],
  );

  const actOnPending = useCallback(async (id: string, action: "steer" | "discard" | "agent-queue"): Promise<void> => {
    const perform = async (): Promise<void> => {
      const owner = queueOwner, pane = paneId;
      const socket = socketRef.current, scope = pendingScopeRef.current;
      if (owner === null || pane === null || paneRef.current !== pane) return;
      if (action === "agent-queue" && agent === "codex" && (agentStatus !== "working" || !socket?.canQueuePendingMessages(agent))) return;
      // what another tab saved since: a copy it is sending again is not confirmed here either
      pendingMessages.refresh(owner);
      const message = pendingMessages.read(owner).find((item) => item.id === id);
      if (!message || message.state === "sending") return;
      if (action !== "discard" && (message.state === "uncertain" || !socket?.connected || heldRef.current || secretRef.current !== null || observeRef.current || ended || heldByOpenQueue || answering !== null)) return;
      if (message.serverOwned && !pendingMessages.isOwned(owner, id, scope)) return;
      // keys held back in the terminal draft would run in front of the message: the server pastes a
      // server-owned row's text and sends Enter without looking for a partial line (only Claude's box
      // is checked there). The row stays as it is, so Send now after the draft is settled, or Discard, still works.
      if (action !== "discard" && draftHeldForRef.current === pane) {
        pendingMessages.fail(owner, id, { code: "held_input", message: "send or discard the held input first" }, false);
        return;
      }
      // a screen a peek left open would take it, as it would the composer's Send
      const open = stillOpenRef.current;
      if (action !== "discard" && open !== null && open.pane === pane) {
        pendingMessages.fail(owner, id, { code: "still_open", message: stillOpenNote(open) }, false);
        return;
      }
      if (!pendingMessages.begin(owner, id)) return;
      try {
        if (message.serverOwned) {
          // A successful action can replay a prior discard. Only the matching sent removal,
          // published before the action result, proves that this explicit Send now ran anything.
          let delivered = false;
          const off = socket?.on((frame) => {
            if (frame.type === "pending-messages" && frame.pane_id === pane
              && frame.removed?.some((item) => item.id === id && item.outcome === "sent")) delivered = true;
          });
          try {
            const known = knownOutcomes(pane);
            const seen = inputRowNow() === "ready";
            const result = socket?.pendingAction(pane, id, action, message.resendGeneration ?? 0);
            // offline: no frame left (the row shows submitNote's wording, not this message)
            if (!result) {
              pendingMessages.fail(owner, id, { code: "not_transmitted", message: "the connection dropped before this message was sent" }, pendingActionUncertain("not_transmitted", message.state));
              return;
            }
            // as a composer send: the pane keeps its connection and lease until the receipt settles
            const releaseSubmit = submitRetention?.retain(pane);
            const answer = await result.finally(() => releaseSubmit?.());
            if (answer.ok && action === "steer" && delivered) showSentCommand(pane, message.text, known, seen);
            if (!answer.ok) pendingMessages.fail(owner, id, { code: answer.code, message: answer.message }, pendingActionUncertain(answer.code, message.state),
              action !== "discard" ? message.resendGeneration ?? 0 : undefined);
          } finally {
            off?.();
          }
          // Only the matching server removal receipt removes an authoritative item.
        } else if (action === "discard") {
          pendingMessages.removeCopy(owner, id);
        } else if (message.state === "held") {
          if (!pendingMessages.unconfirm(owner, id)) {
            return;
          }
          const known = knownOutcomes(pane);
          const seen = inputRowNow() === "ready";
          const result = action === "agent-queue"
            ? submitComposerMessage(message.text, "agent-queue", undefined, false, id, message.resendGeneration ?? 0)
            : submitComposerMessage(message.text, "immediate", undefined, false, id, message.resendGeneration ?? 0);
          if (!result) {
            pendingMessages.fail(owner, id, { code: "not_transmitted", message: "the connection dropped before this message was sent" }, false);
            return;
          }
          const answer = await result;
          if (answer.ok) {
            pendingMessages.removeCopy(owner, id);
            if (action === "steer" && answer.pending === undefined && !answer.unconfirmed) showSentCommand(pane, message.text, known, seen);
          }
          else pendingMessages.fail(owner, id, { code: answer.code, message: answer.message }, !submitNotTyped(answer.code), message.resendGeneration ?? 0);
        }
      } catch {
        pendingMessages.fail(owner, id, { code: "disconnected", message: t("Not confirmed. Check the terminal before sending again.") }, true);
      } finally { pendingMessages.end(owner, id); }
    };
    // Web Locks reduce contention where supported; the bridge's stable resend ID is the
    // authority on LAN HTTP and when two tabs have already read the same held copy.
    if (navigator.locks) await navigator.locks.request(`pending:${queueOwner}:${id}`, perform);
    else await perform();
  }, [agent, agentStatus, answering, ended, heldByOpenQueue, paneId, queueOwner, submitComposerMessage, submitRetention, showSentCommand, inputRowNow, stillOpenNote]);

  return { composerSend, actOnPending };
}

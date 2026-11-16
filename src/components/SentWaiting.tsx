import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { CircleAlert, Clock, X } from "lucide-react";

import { agentDisplayLabel } from "../lib/compose.ts";
import { useT } from "../lib/i18n.ts";
import { agentName } from "../lib/runtimeMove.ts";
import { shouldFoldUserMessage } from "../lib/userMessageFold.ts";
import { clearMachineWaitingSends, currentWaitingSends, dismissWaitingSend, expireWaitingSends, markUnanswered, restingSince, subscribeWaitingSends, WAITING_HINT_MS, WAITING_SEND_MS, WAITING_STUCK_MS, waitingKey, type WaitingSend } from "../lib/sentWaiting.ts";

/**
 * The sends this browser made to a pane that its transcript does not hold yet. A lost connection
 * lets the PC's go, before paint: what became of them is the transcript's to say once it is read
 * again, and nothing is sent again.
 */
export function useWaitingSends(machineId: string, paneId: string, connected: boolean): readonly WaitingSend[] {
  const key = waitingKey(machineId, paneId);
  useLayoutEffect(() => {
    if (!connected) clearMachineWaitingSends(machineId);
  }, [connected, machineId]);
  return useSyncExternalStore(subscribeWaitingSends, () => currentWaitingSends(key));
}

/**
 * Sent, and the agent has not written it as a turn yet: the user's bubble where the turn will be,
 * faded, with nothing under it, as a messenger shows a message at once on Send. Its turn takes its
 * place when the transcript has it; a clock joins it, where the turn's time will be, only when that
 * takes longer than WAITING_HINT_MS. Not come WAITING_SEND_MS after it was sent while the agent rests
 * (`resting`), it is unanswered (markUnanswered): said so under it, with the terminal, where an agent
 * that failed the turn before writing it shows why, and a way to let it go. `paneKey`: waitingKey's.
 */
export function SentWaitingList({ sends, paneKey, resting = false, agent = null, onOpenTerminal }: {
  sends: readonly WaitingSend[]; paneKey?: string; resting?: boolean; /** the pane's agent kind */ agent?: string | null; onOpenTerminal?: () => void;
}) {
  const t = useT();
  const [now, setNow] = useState(Date.now);
  // the next moment a bubble changes: its clock, and while the agent rests, the minute after which it is unanswered
  const watching = paneKey !== undefined && resting;
  const nextHint = sends.reduce((soonest, send) => {
    const hint = send.at + WAITING_HINT_MS;
    const due = send.unanswered === true || paneKey === undefined || hint > now ? hint
      : watching && send.at + WAITING_SEND_MS > now ? send.at + WAITING_SEND_MS : send.at + WAITING_STUCK_MS;
    return due > now && due < soonest ? due : soonest;
  }, Number.POSITIVE_INFINITY);
  // the clock as it is now: an agent that comes to rest long after the minute makes the send unanswered at once
  // since when the agent rests, as this chat saw it: a send is said unanswered only after a read that came since then
  // a layout effect: the rest is cleared in the commit that shows the agent at work, before a read settled in that
  // commit's layout (ChatView) is judged, whatever else updates in it
  useLayoutEffect(() => {
    if (paneKey === undefined) return;
    restingSince(paneKey, resting ? Date.now() : null);
    // a chat opened again judges its sends by a read since then, not by the one its last visit settled
    return () => { restingSince(paneKey, null); };
  }, [paneKey, resting]);
  useEffect(() => {
    if (paneKey === undefined) return;
    markUnanswered(paneKey);
    expireWaitingSends(paneKey);
  }, [paneKey, resting, now]);
  useEffect(() => {
    if (nextHint === Number.POSITIVE_INFINITY) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextHint - Date.now()));
    return () => clearTimeout(timer);
  }, [nextHint]);
  const late = t("Sent · waiting for the agent's next turn");
  // the catalog's product name, or the label the composer gives one it does not list
  const name = agent === null ? null : agentName(agent) === agent ? agentDisplayLabel(agent) : agentName(agent);
  const unanswered = name === null ? t("Not in the conversation. If the agent showed an error, it is in the terminal.")
    : t("Not in the conversation. If {agent} showed an error, it is in the terminal.", { agent: name });
  // no live region of its own: the chat footer has one, and the user's own words need no announcing
  return <div className="chat-sent-waiting-list">
    {sends.map((send) => {
      // capped at the lines its turn's card shows (UserMessage, ChatView.tsx), so the turn takes its
      // place at about its height; the card's fade and Show full message come with the turn
      const capped = shouldFoldUserMessage(send.text);
      // whole: its turn is not coming to take its place with the card's Show full message
      if (send.unanswered === true) return <div key={send.id} className="chat-turn chat-turn-user chat-turn-unanswered" data-unanswered-send={send.id}>
        <div className="chat-user-row">
          <div className="chat-bubble"><div className="chat-bubble-body">{send.text}</div></div>
        </div>
        <p className="chat-unanswered-note"><span className="chat-unanswered-words"><CircleAlert aria-hidden="true" />{unanswered}</span>
          {onOpenTerminal && <button type="button" className="chat-outcome-action" onClick={onOpenTerminal}>{t("Open Terminal")}</button>}
          {paneKey !== undefined && <button type="button" className="chat-meta-btn chat-unanswered-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => dismissWaitingSend(paneKey, send.id)}><X aria-hidden="true" /></button>}
        </p>
      </div>;
      return <div key={send.id} className="chat-turn chat-turn-user chat-turn-waiting">
        <div className="chat-user-row">
          <div className={capped ? "chat-bubble is-capped" : "chat-bubble"}><div className="chat-bubble-body">{send.text}</div></div>
          {now - send.at >= WAITING_HINT_MS && <div className="chat-turn-meta">
            <span className="chat-sent-late" role="img" aria-label={late} title={late}><Clock aria-hidden="true" /></span>
          </div>}
        </div>
      </div>;
    })}
  </div>;
}

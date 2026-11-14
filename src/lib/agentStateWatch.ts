/**
 * Whether the page knew its PCs' agents as they were a moment ago (#3505). A state change is stamped
 * with the time the page saw it (lib/agentStateSince.ts), and that is when it happened only while
 * the page was being told: its roster stream open and the page running, or a roster read moments
 * ago. A page that was not running (a phone asleep, a laptop's lid shut, a tab the browser froze)
 * or that could not reach its server learns of what it missed all at once, later: stamped then, a
 * wait of an hour would say a minute.
 *
 * So the watch keeps the last moment the page's knowledge was current. A roster that comes more
 * than BLIND_MS after it, and every look until one comes, is read as a page's first look is: a
 * stamp stands only where herdr's counter proves it, and a state that began out of sight says no
 * time. A shorter gap (a server that restarts, a stream that reconnects) is within what a time in
 * minutes can say, and its changes are dated as they come.
 *
 * A stream that says nothing for long is no gap while it lives: nothing changed. But a hidden tab
 * reads no roster and probes no connection, so its stream may be dead for hours unnoticed, and
 * only its end tells. So when a stream ends, the page knew its PCs as of the last roster or event
 * it heard, however long ago: the silence since vouches for nothing. A visible tab reads its roster
 * every half minute at least, so there the end of a stream costs no more than that.
 *
 * The read that comes as a hidden tab is shown again, before its socket has probed the connection,
 * takes the stream's silence at its word for now: it dates no change it finds and keeps the times
 * the page had. If the stream then ends within the time its socket takes to find a dead
 * connection, the page was not being told after all, and that roster is read as after a long gap.
 * A stream that takes over from another (the terminal's socket from the event stream) stops that
 * one with no word of its end, so its first roster is read as that read is: it dates nothing.
 *
 * The roster loader tells the watch what it learns (lib/useMachineRoster.ts) and the stamping asks
 * it at each look (lib/useAgentStateSince.ts). A page told of no roster yet has lost nothing.
 */
const BEAT_MS = 5_000;
/**
 * A hidden tab's timers run as seldom as once a minute: a longer silence is a page that was not
 * running, and a longer gap in what the page knew is one its times do not bridge. The stamps go by
 * the same measure for a pane missing from a roster (lib/agentStateSince.ts).
 */
export const BLIND_MS = 90_000;
/**
 * How long after a read took a silent stream at its word the stream may still prove to have been
 * dead: its socket probes the connection as the page comes back and drops one that does not answer
 * twice (lib/ws.ts, 3 s each at first).
 */
const VERDICT_MS = 30_000;

/** a look that cannot date what it finds: `first` as a page's first look, `undated` with the times the page had kept */
export type UnseenLook = "first" | "undated";

/** the last moment the page's knowledge of its PCs was current: null before any roster */
let knownAt: number | null = null;
/** the last moment the server was heard from: a roster, or any event of a stream that vouches */
let heardAt: number | null = null;
/** the last moment the page was seen to run */
let beatAt: number | null = null;
/** how often the page was found not to have been running: a read asked before the last of them answers with old news */
let gaps = 0;
/**
 * The roster stream: `opening` until its own first roster, then `live`, telling of every change as
 * it happens; `none` without one, or with one whose events may have waited while the page did not run.
 */
let stream: "none" | "opening" | "live" = "none";
let subscribed = false;
/** until when the end of the stream says it was dead all along: a read has just taken its silence for nothing having happened */
let trustedUntil: number | null = null;
let unseen: ((look: UnseenLook) => void) | null = null;

/** The page runs now. A stream that vouches has kept its knowledge current since the last beat, unless that is too long ago. */
function beat(): number {
  const now = Date.now();
  if (beatAt !== null && now - beatAt > BLIND_MS) {
    gaps++;
    stream = "none";
  } else if (stream === "live") knownAt = now;
  beatAt = now;
  return now;
}

/** The roster as it is now reached the page: a read's answer, a stream's own first roster (`opening`), or what a stream that vouches pushed. */
function whole(now: number, by: "read" | "opening" | "stream"): void {
  const look: UnseenLook | null = knownAt !== null && now - knownAt > BLIND_MS ? "first"
    // the page held itself told by a stream that said nothing for as long: nothing changed, or it was dead. Of the
    // stream a read finds silent, its socket finds that out only later (lib/ws.ts). Of one that the stream now
    // opening took over from, nothing does: it was stopped with no word of its end, or the page would not hold itself told
    : by !== "stream" && heardAt !== null && now - heardAt > BLIND_MS ? "undated" : null;
  knownAt = now;
  heardAt = now;
  // only a stream that is still open can prove dead: the one a read trusted
  trustedUntil = by !== "read" ? null : look === "undated" ? now + VERDICT_MS : trustedUntil;
  if (look !== null) unseen?.(look);
}

export const stateWatch = {
  /** A read of the roster starts: what to hand back with its answer. */
  asked(): number {
    beat();
    return gaps;
  },
  /** The read started at `asked` answered, in the batch that draws its roster. */
  read(asked: number): void {
    const now = beat();
    if (asked !== gaps) return;
    whole(now, "read");
    // a stream still open tells of what changes from here on: its socket drops a dead connection by itself
    if (subscribed && stream === "none") stream = "live";
  },
  /** The roster stream's subscription opened, or ended (`lost`, `closed`). One that opens while another is open takes over from it. */
  subscription(update: "opened" | "lost" | "closed"): void {
    const now = beat();
    if (update !== "opened") {
      // the stream whose silence a read has just trusted ends: it was dead, for no telling how long
      if (trustedUntil !== null && now <= trustedUntil) unseen?.("first");
      // a stream that ends vouches for nothing it left unsaid: the page knew its PCs as of the last roster or event it heard
      else if (knownAt !== null && heardAt !== null && heardAt < knownAt) knownAt = heardAt;
    }
    trustedUntil = null;
    subscribed = update === "opened";
    stream = subscribed ? "opening" : "none";
  },
  /** An event of the roster stream reached the page. */
  heard(): void {
    const now = beat();
    if (stream !== "live") return;
    heardAt = now;
    trustedUntil = null;
  },
  /** A roster the stream pushed, in the batch that draws it. */
  pushed(): void {
    const now = beat();
    if (stream === "none") return;
    const by = stream === "opening" ? "opening" : "stream";
    stream = "live";
    whole(now, by);
  },
  /** Whether a look now cannot say when a change began: the page's knowledge was not current a moment ago. */
  blind(): boolean {
    const now = beat();
    return knownAt !== null && now - knownAt > BLIND_MS;
  },
  /**
   * The stamping keeps the watch while its page lives, from the page's start: nothing is known
   * yet and no stream is open (App keeps it before the roster stream first opens), so what a page
   * before it knew is not this one's. `look` is called, in the batch that draws it, with how to
   * read a roster that cannot date what it brings. Hands back the watch's end. The watch has one
   * keeper at a time: keeping it starts it anew, so a second keeper would take the first one's
   * knowledge with it. A list that wants the times reads the stamps (lib/useAgentStateSince.ts).
   */
  keep(look: (look: UnseenLook) => void): () => void {
    unseen = look;
    knownAt = null;
    heardAt = null;
    beatAt = null;
    stream = "none";
    subscribed = false;
    trustedUntil = null;
    beat();
    const timer = setInterval(beat, BEAT_MS);
    return () => {
      clearInterval(timer);
      // a later keeper's listener is not this one's to end
      if (unseen === look) unseen = null;
    };
  },
};

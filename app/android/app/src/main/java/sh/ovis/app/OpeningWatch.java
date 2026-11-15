package sh.ovis.app;

/**
 * What MainActivity's cover says while a PC opens, from what has arrived and when. A PC whose first
 * page has answered (its response committed) is never called off: it keeps loading as long as bytes
 * come, and one that stops sending is told so (STALLED), with Keep waiting, rather than cut off.
 * Before that answer the open gives up (NO_ANSWER) once the answer limit has passed with nothing
 * arriving for QUIET_MS, or nothing at all, and in any case at UNANSWERED_MAX_MS: bytes alone (a
 * slow TLS handshake) put it off, but a server that completes its handshake and never responds
 * still gets the error page. Times are in milliseconds on any one clock (SystemClock.elapsedRealtime
 * in the app); byte counts are the app's received total (TrafficStats), or a negative number where
 * the phone cannot count them. That total is the whole app's, not this load's alone (a check still
 * running from an earlier screen counts too), which is why bytes without an answer only put the
 * limit off, never past UNANSWERED_MAX_MS.
 */
final class OpeningWatch {
    enum Stage {
        /** Nothing to say yet: "Opening …". */
        OPENING,
        /** The PC answered, or bytes arrive, and the page still has not shown: a slow link. */
        SLOW,
        /** It answered, then nothing arrived for STALL_MS. */
        STALLED,
        /** No answer within the limit (connectedOnly says whether bytes came): the error page. */
        NO_ANSWER
    }

    /** How long a first page may take before the cover calls the link slow. */
    static final long SLOW_AFTER_MS = 5000;

    /** How long nothing may arrive, once something has, before the cover says the link stalled. */
    static final long STALL_MS = 20000;

    /**
     * What must arrive before it counts as an answer without the page's own: a TLS handshake or an
     * HTTP answer is more, while a server that accepts the connection and never sends gives the app
     * only TCP's own packets, a few hundred bytes at most.
     */
    static final long FIRST_BYTES = 1024;

    /** Before an answer, how long nothing may arrive once the answer limit has passed. */
    static final long QUIET_MS = 5000;

    /** The longest an open waits for an answer however many bytes come. */
    static final long UNANSWERED_MAX_MS = 60000;

    /**
     * The most the bar shows, in thousandths, until the client is up: the byte count includes TLS and
     * headers, so it can reach the files' total before the last of them has arrived, and the
     * script still has to run.
     */
    static final int MAX_PERMILLE = 950;

    private int shownPermille = -1;

    private final long startedAt;
    private final long answerLimitMs;
    private final long baseBytes;
    private long lastBytes;
    private boolean answered;
    private boolean arrived;
    private long lastProgressAt;

    /** An open that started at `now`, given `answerLimitMs` to answer, with `bytes` received so far. */
    OpeningWatch(long now, long answerLimitMs, long bytes) {
        this.startedAt = now;
        this.answerLimitMs = answerLimitMs;
        this.baseBytes = bytes;
        this.lastBytes = bytes;
        this.lastProgressAt = now;
    }

    /** The PC answered the first page: its response committed in the WebView. */
    void answered(long now) {
        answered = true;
        arrived = true;
        lastProgressAt = now;
    }

    /** The app's received total is `bytes` at `now`: more than before is progress. */
    void received(long now, long bytes) {
        if (bytes < 0 || baseBytes < 0 || bytes <= lastBytes) return;
        lastBytes = bytes;
        if (!arrived && bytes - baseBytes < FIRST_BYTES) return;
        arrived = true;
        lastProgressAt = now;
    }

    /** Keep waiting on a stalled open: the stall is counted again from `now`. */
    void keepWaiting(long now) {
        lastProgressAt = now;
    }

    /** Bytes received since the open started, 0 where the phone cannot count them. */
    long bytesSoFar() {
        return baseBytes < 0 ? 0 : lastBytes - baseBytes;
    }

    /**
     * How far the page's files have come, in thousandths of `expectedBytes` (the sum of their sizes),
     * or -1 when that is unknown (0 or less) or the phone cannot count bytes. Never less than it said
     * before, and never more than MAX_PERMILLE.
     */
    int permille(long expectedBytes) {
        if (expectedBytes <= 0 || baseBytes < 0) return -1;
        int now = (int) Math.min(MAX_PERMILLE, bytesSoFar() * 1000 / expectedBytes);
        shownPermille = Math.max(shownPermille, now);
        return shownPermille;
    }

    /** Whether the PC's page has answered (answered). */
    boolean isAnswered() {
        return answered;
    }

    /** Whether bytes came but the page never answered: a connection that opened, and no response on it. */
    boolean connectedOnly() {
        return arrived && !answered;
    }

    Stage stage(long now) {
        long elapsed = now - startedAt;
        if (!answered) {
            boolean quiet = !arrived || now - lastProgressAt >= QUIET_MS;
            if ((elapsed >= answerLimitMs && quiet) || elapsed >= UNANSWERED_MAX_MS) return Stage.NO_ANSWER;
            return arrived && elapsed >= SLOW_AFTER_MS ? Stage.SLOW : Stage.OPENING;
        }
        if (now - lastProgressAt >= STALL_MS) return Stage.STALLED;
        return now - startedAt >= SLOW_AFTER_MS ? Stage.SLOW : Stage.OPENING;
    }
}

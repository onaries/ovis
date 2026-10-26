// Ovis for Mac writes this into the page at a new address (another port is another origin, with
// storage of its own) before the page's code starts: the unsent drafts read from the page the window
// left (WebPage.swift). Nothing here sends anything; a draft waits in the page for Send or Discard.
//
// The app's storage is its own, so what the new origin holds is from the app's earlier visit there,
// older than the page just left: a carried key replaces it, and a chat send left on its way there is
// over (the new page has none of its own yet). Unless `shared`, a window the page opened still open
// there: then that window's drafts and sends are live, and a carried key only fills a gap.
//
// `ovis-mac:carried` records the carry's token, the keys that landed, and the value each carried key held
// before the carry began (`before`), all in its first write: a carry that cannot write it writes nothing.
// A later run of the same carry (a reload, a window the page opened) writes a key that has not landed only
// while it still holds that value; one the page changed since is the page's own, so carried text never goes
// back over what was typed since. The baselines also go to the app first (`post`), which hands them back
// (`given`) to a run after a mark that did not fit. `loaded` is set once the page has loaded (WebPage.swift):
// from then on the user may type, so a carry with no baselines only fills keys the page holds none of. The
// app reads the landed keys when the page has loaded and keeps the rest; the old origin keeps its copy.
function ovisCarryDrafts(storage, carried, shared, token, loaded, given, post) {
  const MARK = "ovis-mac:carried";
  let mark = null;
  try {
    mark = JSON.parse(storage.getItem(MARK) ?? "null");
  } catch {
    // storage that cannot be read takes nothing; a mark that is not JSON is not this carry's
  }
  const again = mark !== null && typeof mark === "object" && mark.token === token && Array.isArray(mark.done)
    && mark.before !== null && typeof mark.before === "object";
  const landed = new Set(again ? mark.done : []);
  const before = again ? mark.before : given ?? {};
  const save = () => {
    try {
      storage.setItem(MARK, JSON.stringify({ token, done: [...landed], before }));
      return true;
    } catch {
      return false;
    }
  };
  if (!again) {
    if (!given && !loaded) {
      try {
        for (const key of Object.keys(carried)) before[key] = storage.getItem(key);
      } catch {
        return;
      }
      try {
        post?.({ token, before });
      } catch {
        // no app to keep them (a browser, a test): the mark alone holds them
      }
    }
    // the mark first, with every baseline: a draft written without one could be written again over typing
    if (!save()) return;
    if (!loaded && !shared) {
      try {
        const leases = [];
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key && key.startsWith("ovis:composer-sending:") && !Object.hasOwn(carried, key)) leases.push(key);
        }
        for (const key of leases) storage.removeItem(key);
      } catch {
        // a lease left behind runs out by itself
      }
    }
  }
  for (const [key, value] of Object.entries(carried)) {
    if (landed.has(key)) continue;
    try {
      const now = storage.getItem(key);
      // the page's own: a window of it still open there, or a value that is not the one the carry began with
      const pagesOwn = shared || !Object.hasOwn(before, key) ? now !== null : now !== before[key];
      if (!pagesOwn) storage.setItem(key, value);
      landed.add(key);
      save();
    } catch {
      // one key that does not fit (a full store) does not stop the rest; it stays in the app to retry
    }
  }
}

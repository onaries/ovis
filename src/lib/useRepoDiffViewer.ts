import { useCallback, useEffect, useRef, useState } from "react";

import { WEB_PANEL_BELOW_KEY, webPagesBelow } from "./historyKeys.ts";
import { backUnderCurrentEntry } from "./historyNavigation.ts";
import { diffTargetFromState, diffTargetState, type RepoDiffTarget } from "./repoDiff.ts";

/**
 * A repository diff is a history entry above the Files list, as a file preview is (useFileViewer):
 * Android Back closes it, and a reload or Forward restores it with its PC, pane and comparison.
 */
export function useRepoDiffViewer() {
  const [viewing, setViewing] = useState(() => diffTargetFromState(window.history.state));
  const closing = useRef(false);

  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      closing.current = false;
      setViewing(diffTargetFromState(event.state));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openDiff = useCallback((target: RepoDiffTarget) => {
    if (closing.current) return;
    const state = diffTargetState(window.history.state, target);
    // another file of the same list replaces the entry: Back still returns to the list in one step
    if (diffTargetFromState(window.history.state)) window.history.replaceState(state, "");
    else {
      // an entry of its own holds none of the web panel's entries under the one it copies (#3095): a
      // file that takes it over must not go back past them
      const { [WEB_PANEL_BELOW_KEY]: _below, ...pushed } = state;
      window.history.pushState(pushed, "");
    }
    setViewing(target);
  }, []);

  const closeDiff = useCallback(() => {
    if (closing.current) return;
    if (diffTargetFromState(window.history.state)) {
      closing.current = true;
      // past a copy of the diff's entry a phone sheet left (a reload under it) too (#3101)
      backUnderCurrentEntry(1 + webPagesBelow(window.history.state))?.catch(() => { closing.current = false; });
    } else setViewing(null);
  }, []);

  /** Hand the current entry to another viewer without traversing back to the list. */
  const releaseDiff = useCallback(() => {
    window.history.replaceState(diffTargetState(window.history.state, null), "");
    setViewing(null);
  }, []);

  return { viewing, openDiff, closeDiff, releaseDiff };
}

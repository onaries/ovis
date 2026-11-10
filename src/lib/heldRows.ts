/** How the held-message list above the composer shows: its rows, or only its caption. */

/**
 * A phone window with too little height for the rows. This is the layout viewport: Android
 * Chrome shrinks it for the keyboard, iOS Safari does not (see lib/viewport.ts), so an iPhone
 * with its keyboard up is not a short phone here.
 */
export const SHORT_PHONE_QUERY = "(max-width: 480px) and (max-height: 600px)";

export interface HeldRowsState {
  /** a prompt card is open in this pane's chat */
  promptOpen: boolean;
  /** SHORT_PHONE_QUERY matches */
  shortPhone: boolean;
  /** the agent is ready: the list asks for the user's own action */
  ready: boolean;
}

/**
 * Whether the rows give their room away and fold into the caption, which is then a disclosure
 * button. A list that asks for an action is never folded: Send now stays in sight.
 */
export function heldRowsFold({ promptOpen, shortPhone, ready }: HeldRowsState): boolean {
  return !ready && (promptOpen || shortPhone);
}

/**
 * Whether a row shows a send error right now. The error outlives its message (it is cleared by
 * the next send only), so one whose message was discarded, or belongs to another pane, is no row's.
 */
export function heldRowError(error: { owner: string; id: string } | null, owner: string | null, ids: readonly string[]): boolean {
  return error !== null && error.owner === owner && ids.includes(error.id);
}

/**
 * Whether a fold that starts now starts with its rows open: only when the user is in one of this
 * pane's rows at that moment (a phone's keyboard came up for the message being edited). Another
 * pane's rows, or a list that was just emptied, say nothing about this one.
 */
export function heldOpenAtFold({ fold, sameOwner, focusInRows }: { fold: boolean; sameOwner: boolean; focusInRows: boolean }): boolean {
  return fold && sameOwner && focusInRows;
}

/**
 * Whether the rows count as opened by the user once focus is in one of them. Under a fold they can
 * be in sight for another reason (a row's error); when that reason goes, from another tab too, the
 * row being edited must not fold away with it.
 */
export function heldOpenOnFocus(fold: boolean, opened: boolean): boolean {
  return opened || fold;
}

/**
 * Whether the caption is the disclosure button. While a row's error holds the rows open the
 * button could not close them, so the caption is plain text until the error is gone.
 */
export function heldToggleShown(fold: boolean, rowError: boolean): boolean {
  return fold && !rowError;
}

/**
 * Whether focus that was on the button as it went moves to the list now in the page: only to the
 * list that button controlled. After a pane switch the list is the other pane's, and that pane's
 * own focus (its message box, or none on a touch screen) is left alone.
 */
export function heldRefocusDue(controlled: string | null, listId: string | null): boolean {
  return controlled !== null && controlled === listId;
}

/**
 * Whether the rows are hidden. Folding only hides: the rows stay mounted, and they show while
 * the user opened them or one of them carries an error the user has to read.
 */
export function heldRowsHidden(fold: boolean, opened: boolean, rowError: boolean): boolean {
  return fold && !opened && !rowError;
}

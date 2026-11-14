/**
 * Where focus goes when the control that had it is gone: Add PC closed Settings behind it, a
 * closed row left the roster. The header's workspace-list toggle is the control nearest the PC
 * list, and one of the two is always shown: the drawer's on a phone, the sidebar's on a desktop.
 * A phone's thread in the inbox mode draws Back in the drawer toggle's place: the focus goes there
 * when no toggle is shown.
 * Runs a frame later, once React has taken the vanished control out of the document. With `lost`, only a focus that
 * is nowhere by then is given a place (the inbox mode left with its controls, lib/useInbox.ts): what took it
 * meanwhile keeps it, the header's More a closed menu gave it back to, a dialog, the pane.
 */
export function focusWorkspaceListToggle(when: "always" | "lost" = "always"): void {
  window.requestAnimationFrame(() => {
    if (when === "lost" && document.activeElement !== null && document.activeElement !== document.body) return;
    const shown = (selector: string): HTMLElement | undefined => [...document.querySelectorAll<HTMLElement>(selector)].find((toggle) => toggle.getClientRects().length > 0);
    (shown(".app-header .drawer-toggle, .app-header .sidebar-toggle") ?? shown(".app-header .inbox-back"))?.focus();
  });
}

/**
 * Whether a modal surface is up (Settings, a dialog). A pane that appears under one, as a link
 * that opens Settings mounts it beneath the dialog (lib/deepLink.ts), must not take the focus out
 * of the modal: its composer and its grid leave the keyboard where it is.
 */
export function modalOpen(): boolean {
  return document.querySelector("[aria-modal='true'], dialog[open]") !== null;
}

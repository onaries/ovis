import { MessageCircle, SquareTerminal } from "lucide-react";
import type { PaneView } from "../lib/actions.ts";
import { useT } from "../lib/i18n.ts";

/**
 * A phone's Chat/Terminal switch: one button that shows the lens a press opens, as a split half's own lens
 * button does, instead of a two-option track. A terminal peek over the chat is the terminal shown: a press
 * ends it. Mod+Shift+J and the palette's item run the same switch.
 */
export function LensToggle({ view, peek, terminalAttach, title, onToggle }: {
  view: PaneView;
  peek: boolean;
  terminalAttach: boolean;
  /** the label with its shortcut, as the wide switch's lenses say it */
  title: (label: string) => string;
  onToggle: () => void;
}) {
  const t = useT();
  const shown: PaneView = peek ? "terminal" : view;
  const toTerminal = shown === "chat";
  const label = t(toTerminal ? "Switch to terminal" : "Switch to chat");
  // a Windows PC's live terminal is not there yet: the button says so, as the wide switch's pill does
  const soon = toTerminal && !terminalAttach;
  return (
    <button type="button" className="icon-button is-outlined lens-toggle" data-view={shown}
      aria-label={soon ? `${label} · ${t("soon")}` : label}
      title={soon ? t("Live terminal: coming to Windows PCs once herdr can attach there") : title(label)}
      onClick={onToggle}>
      {toTerminal ? <SquareTerminal aria-hidden="true" /> : <MessageCircle aria-hidden="true" />}
    </button>
  );
}

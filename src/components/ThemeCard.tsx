/** A theme as a small picture of the app in its own colours, its name under it: Settings → Appearance and the setup guide's theme step. */
import type { DrawnTheme, Mode, ThemeId } from "../lib/themes.ts";
import { useT } from "../lib/i18n.ts";
import "./SettingsControls.css";

/** What each theme is called: the color words are translated, the brand names stay as their projects write them. */
export const THEME_NAMES: Record<ThemeId, string> = {
  amber: "Amber",
  charcoal: "Charcoal",
  codex: "Codex",
  catppuccin: "Catppuccin",
  "catppuccin-latte": "Catppuccin Latte",
  "tokyo-night": "Tokyo Night",
  "black": "Black",
  "tokyo-night-day": "Tokyo Night Day",
  gruvbox: "Gruvbox",
  "gruvbox-light": "Gruvbox Light",
  "one-dark": "One Dark",
  "one-light": "One Light",
  solarized: "Solarized",
  "solarized-light": "Solarized Light",
  kanagawa: "Kanagawa",
  "kanagawa-lotus": "Kanagawa Lotus",
  "rose-pine": "Rosé Pine",
  "rose-pine-dawn": "Rosé Pine Dawn",
  dracula: "Dracula",
  nord: "Nord",
  vesper: "Vesper",
};

/**
 * One theme as a small picture of the app in its own colours, a sidebar beside a pane, its name under it (the cards T3 Code
 * and herdr-app show). `row` is what the theme draws on `side`: a built-in theme's row, or an imported theme's (lib/customThemes.ts).
 */
export function ThemeCard({ card, name, row, side, checked, focusable = checked, onPick }: { card: string; name: string; row: DrawnTheme; side: Mode; checked: boolean; /** the group's tab stop: the checked card, or the first where none is */ focusable?: boolean; onPick: () => void }) {
  const t = useT();
  const c = row.preview;
  // a theme of the other kind says so: it draws that way on this side; every card's tooltip carries its
  // whole name, as the name under the picture may be cut (G-204)
  const kind = row.mode === side ? undefined : `${name} · ${t(row.mode === "dark" ? "Dark" : "Light")}`;
  return (
    <button type="button" role="radio" aria-checked={checked} aria-label={kind} title={kind ?? name} tabIndex={focusable ? 0 : -1} className="theme-card" data-theme-card={card} onClick={onPick}>
      <span className="theme-card-art" aria-hidden="true" style={{ background: row.bg, borderColor: c.border }}>
        <span className="theme-card-side" style={{ background: row.bgPanel, borderColor: c.border }}>
          <i style={{ background: c.accent }} /><i style={{ background: c.textDim }} /><i style={{ background: c.textDim }} />
        </span>
        <span className="theme-card-pane" style={{ background: c.elevated, borderColor: c.border }}>
          <i style={{ background: c.text }} /><i style={{ background: c.textDim }} /><b style={{ background: c.primary }} />
        </span>
      </span>
      <span className="theme-card-name">{name}</span>
    </button>
  );
}

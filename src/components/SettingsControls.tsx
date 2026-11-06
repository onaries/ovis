import { createContext, isValidElement, useContext, type ComponentProps, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Minus, Plus } from "lucide-react";

import { DEFAULT_SETTINGS, useSettings, type Settings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";

import "./SettingsControls.css";

/**
 * The parts every Settings page is built from: a group is a caption over one card, a card holds
 * rows parted by hairlines, and a row is a label with its one control at the end of the line.
 */
/**
 * The words typed in Settings' search (SettingsDialog.tsx): while it holds any, a row draws only
 * when its label and description hold every one of them, and a group whose title holds them all
 * shows each of its rows. Outside a search it is empty and nothing is filtered.
 */
export const SettingsQuery = createContext<readonly string[]>([]);

/** What a search matches by: case and full-width forms folded, so "Font" finds "font". */
const folded = (text: string): string => text.normalize("NFKC").toLocaleLowerCase();

export function settingsQueryWords(query: string): string[] {
  return folded(query).split(/\s+/).filter((word) => word !== "");
}

/** The words a label or description shows, a description built of elements (a sentence and a warning) included. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

export function matchesSettingsQuery(words: readonly string[], ...texts: ReactNode[]): boolean {
  const shown = folded(texts.map(textOf).join(" "));
  return words.every((word) => shown.includes(word));
}

/**
 * The groups a page keeps out of its first view, folded under one line at its end: **More settings**
 * for what few people change, **Experimental** for what is still being shaped. The line counts the
 * `keys` this device has moved off their defaults, and `elsewhere` more choices kept outside the
 * settings record (Alerts' filters), so a choice is never hidden without a trace. A
 * search shows what it finds inside as if unfolded; a link to a group inside opens it
 * (SettingsDialog.tsx). Native details, so the browser's find-in-page opens it too.
 */
export function SettingsFold({ kind, keys, elsewhere = 0, children }: { kind: "more" | "experimental"; keys: readonly (keyof Settings)[]; elsewhere?: number; children: ReactNode }) {
  const t = useT();
  const words = useContext(SettingsQuery);
  const { settings } = useSettings();
  if (words.length > 0) return <>{children}</>;
  const changed = keys.filter((key) => JSON.stringify(settings[key]) !== JSON.stringify(DEFAULT_SETTINGS[key])).length + elsewhere;
  return (
    <details className="settings-fold" data-fold={kind}>
      <summary>
        <ChevronRight className="settings-fold-chevron" aria-hidden="true" />
        <span className="settings-fold-title">{kind === "more" ? t("More settings") : t("Experimental")}</span>
        {changed > 0 && <span className="settings-fold-changed">{t("{count} changed", { count: changed })}</span>}
      </summary>
      <div className="settings-fold-body">{children}</div>
    </details>
  );
}

/** `section`: the group's name in a link to it (`?settings=<page>&section=<name>`, lib/deepLink.ts) */
export function SettingsGroup({ title, note, className, section, children }: { title?: string; note?: ReactNode; className?: string; section?: string; children: ReactNode }) {
  const words = useContext(SettingsQuery);
  const titled = words.length > 0 && title !== undefined && matchesSettingsQuery(words, title);
  return (
    <section className={className ? `settings-section ${className}` : "settings-section"} data-section={section} data-found={titled ? "" : undefined} tabIndex={section ? -1 : undefined}>
      {title !== undefined && <h3>{title}</h3>}
      {note !== undefined && <p className="settings-description settings-note">{note}</p>}
      <div className="settings-card">{titled ? <SettingsQuery.Provider value={[]}>{children}</SettingsQuery.Provider> : children}</div>
    </section>
  );
}

/**
 * One setting. `wide` marks a control that needs the whole line on a phone (three or more
 * segments, a text field): the row stacks there, and stays one line everywhere else. `keywords`:
 * more words a search finds it by, for a row opened by another. `held`: a row in the middle of a
 * step (a recording, a confirmation) stays in a search whatever its words have become.
 */
export function SettingsRow({ label, description, keywords, held = false, htmlFor, wide = false, children }: { label: string; description?: ReactNode; keywords?: string; held?: boolean; htmlFor?: string; wide?: boolean; children: ReactNode }) {
  const words = useContext(SettingsQuery);
  if (!held && words.length > 0 && !matchesSettingsQuery(words, label, description, keywords)) return null;
  return (
    <div className={wide ? "settings-row is-wide" : "settings-row"} data-setting="">
      <div className="settings-row-text">
        {htmlFor !== undefined ? <label className="settings-label" htmlFor={htmlFor}>{label}</label> : <span className="settings-label">{label}</span>}
        {description !== undefined && <span className="settings-description">{description}</span>}
      </div>
      {children}
    </div>
  );
}

/** `id` for a `<label htmlFor>` beside it; `describedBy`: the id of the hint read with it */
export function Toggle({ checked, label, onChange, disabled, id, describedBy }: { checked: boolean; label: string; onChange: (checked: boolean) => void; disabled?: boolean; id?: string; describedBy?: string }) {
  return (
    <button type="button" id={id} className="settings-toggle" role="switch" aria-checked={checked} aria-label={label} aria-describedby={describedBy} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="settings-toggle-thumb" />
    </button>
  );
}

export function SettingsSelect({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <span className={className ? `settings-select-wrap ${className}` : "settings-select-wrap"}>
      <select {...props} className="select settings-select">{children}</select>
      <ChevronDown aria-hidden="true" />
    </span>
  );
}

export interface SegmentedOption<T extends string> { value: T; label: string }

/** One of a few short choices, all in sight. Five or more go in a select instead. */
export function Segmented<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: readonly SegmentedOption<T>[]; onChange: (value: T) => void; disabled?: boolean }) {
  return (
    <div className="segmented settings-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} disabled={disabled} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

/** A number moved one step at a time between its limits, shown as `text`. */
export function Stepper({ label, value, text, min, max, decreaseLabel, increaseLabel, onChange }: { label: string; value: number; text: string; min: number; max: number; decreaseLabel: string; increaseLabel: string; onChange: (value: number) => void }) {
  return (
    <div className="settings-stepper" role="group" aria-label={label}>
      <button type="button" className="icon-button" aria-label={decreaseLabel} disabled={value <= min} onClick={() => onChange(value - 1)}><Minus aria-hidden="true" /></button>
      <output aria-live="polite">{text}</output>
      <button type="button" className="icon-button" aria-label={increaseLabel} disabled={value >= max} onClick={() => onChange(value + 1)}><Plus aria-hidden="true" /></button>
    </div>
  );
}

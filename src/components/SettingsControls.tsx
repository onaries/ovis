import type { ComponentProps, ReactNode } from "react";
import { ChevronDown, Minus, Plus } from "lucide-react";

import "./SettingsControls.css";

/**
 * The parts every Settings page is built from: a group is a caption over one card, a card holds
 * rows parted by hairlines, and a row is a label with its one control at the end of the line.
 */
/** `section`: the group's name in a link to it (`?settings=<page>&section=<name>`, lib/deepLink.ts) */
export function SettingsGroup({ title, note, className, section, children }: { title?: string; note?: ReactNode; className?: string; section?: string; children: ReactNode }) {
  return (
    <section className={className ? `settings-section ${className}` : "settings-section"} data-section={section} tabIndex={section ? -1 : undefined}>
      {title !== undefined && <h3>{title}</h3>}
      {note !== undefined && <p className="settings-description settings-note">{note}</p>}
      <div className="settings-card">{children}</div>
    </section>
  );
}

/**
 * One setting. `wide` marks a control that needs the whole line on a phone (three or more
 * segments, a text field): the row stacks there, and stays one line everywhere else.
 */
export function SettingsRow({ label, description, htmlFor, wide = false, children }: { label: string; description?: ReactNode; htmlFor?: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? "settings-row is-wide" : "settings-row"}>
      <div className="settings-row-text">
        {htmlFor !== undefined ? <label className="settings-label" htmlFor={htmlFor}>{label}</label> : <span className="settings-label">{label}</span>}
        {description !== undefined && <span className="settings-description">{description}</span>}
      </div>
      {children}
    </div>
  );
}

export function Toggle({ checked, label, onChange, disabled }: { checked: boolean; label: string; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" className="settings-toggle" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}>
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
export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly SegmentedOption<T>[]; onChange: (value: T) => void }) {
  return (
    <div className="segmented settings-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>
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

import type { FoundHerdrSession, FoundOvis, SshTarget } from "../../shared/machines.ts";
import { useT } from "../lib/i18n.ts";
import { machineErrorText } from "../lib/userError.ts";

export type HerdrChoice = Pick<SshTarget, "session" | "herdr_socket" | "start_new_herdr" | "own_ovis">;

const FRESH_CHOICE = new Set(["Choose this PC's Ovis server or a running herdr session.", "A herdr session is already running on this PC. Choose it, or start a new one."]);

export function asksChoice(error: string | null | undefined, sessions: readonly FoundHerdrSession[], ownOvis: readonly FoundOvis[]): boolean {
  return (!error || FRESH_CHOICE.has(error)) && (ownOvis.length > 0 || sessions.length > 0);
}

export function FoundHerdrChoices({ sessions, ownOvis = [], error, busy, onChoose }: { sessions: FoundHerdrSession[]; ownOvis?: FoundOvis[]; error?: string | null; busy: boolean; onChoose(choice: HerdrChoice): void }) {
  const t = useT();
  const question = asksChoice(error, sessions, ownOvis);
  const reason = !question && error ? machineErrorText(error, t) : null;
  return <div className={`machine-action${question ? " is-setup" : ""}`} role="status">
    {reason !== null && <p className="machine-action-text"><strong>{reason}</strong></p>}
    {ownOvis.length > 0 && <p className="machine-action-text">{reason === null ? <strong>{t("Ovis on this PC (herdr-core)")}</strong> : <span>{t("Ovis on this PC (herdr-core)")}</span>}</p>}
    {ownOvis.map((found) => <div className="machine-own-address" key={found.socket_path}>
      <code>{found.socket_path}</code>
      <button type="button" className={question ? "btn btn-primary" : "btn"} disabled={busy} onClick={() => onChoose({ own_ovis: found.socket_path, herdr_socket: undefined, start_new_herdr: undefined })}>{t("Use Ovis on this PC (herdr-core)")}</button>
    </div>)}
    {ownOvis.length ? sessions.length > 0 && <p className="machine-action-text"><span>{t("Or a herdr session running on this PC")}</span></p> : reason !== null ? null : sessions.length ? <p className="machine-action-text"><strong>{t("A herdr session is already running on this PC")}</strong><span>{t("Choose the session to use, or start a new herdr here.")}</span></p>
      : <p className="machine-action-text"><strong>{t("The chosen herdr session is no longer running")}</strong><span>{t("Start it on that PC and reconnect, or start a new herdr here.")}</span></p>}
    {sessions.map((found) => <div className="machine-own-address" key={found.socket_path}>
      <span>{found.session ?? t("Default session")}</span>
      <code>{found.socket_path}</code>
      <button type="button" className="btn" disabled={busy} onClick={() => onChoose({ session: found.session, herdr_socket: found.socket_path, start_new_herdr: undefined, own_ovis: undefined })}>{t("Use {label}", { label: found.session ?? t("Default session") })}</button>
    </div>)}
    <button type="button" className="btn" disabled={busy} onClick={() => onChoose({ herdr_socket: undefined, start_new_herdr: true, own_ovis: undefined })}>{t("Start a new herdr here")}</button>
  </div>;
}

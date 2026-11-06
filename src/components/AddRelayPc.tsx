import { useRef, useState } from "react";

import type { Machine } from "../../shared/machines.ts";
import { addFoundRelayPc, addRelayPc, ApiError, findRelayPc } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { codeFailureText, typedCodeFailure } from "./codeFailureText.ts";
import { KeyId } from "./KeyId.tsx";
import { SettingsRow } from "./SettingsControls.tsx";

/**
 * Another PC through the Ovis relay, no SSH: the code it shows under Connect a device (or an older Ovis's pairing link)
 * pairs this PC's server with it as a phone would. Both hold a one-time code, so they
 * stay in the input, never in state. A typed code first finds the PC, and the person matches its ID with the one that
 * PC shows atop My devices before it is added, as the hosted app's code screen asks (RelayShell.tsx).
 */
export function AddRelayPc() {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ ticket: string; server_id: string; name: string | null } | null>(null);
  const [result, setResult] = useState<{ error: boolean; text: string } | null>(null);
  const added = (machine: Machine) => setResult({ error: false, text: t("{name} was added. Its workspaces join the sidebar.", { name: machine.name }) });
  const failed = (error: unknown) => {
    const failure = error instanceof ApiError ? typedCodeFailure(error.code) : null;
    setResult({ error: true, text: failure !== null ? codeFailureText(t, failure) : error instanceof Error ? error.message : String(error) });
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setResult(null);
    try { await work(); } catch (error) { failed(error); } finally { setBusy(false); }
  };
  const submit = () => {
    const field = input.current;
    const value = field?.value.trim() ?? "";
    if (!field || !value) return;
    // a link carries its offer; anything else is taken as a typed code
    const link = /^https?:\/\//i.test(value);
    void run(async () => {
      if (link) { added((await addRelayPc(value)).machine); field.value = ""; return; }
      // one try per tap, as on the phone: the code is not kept for another
      field.value = "";
      setFound(await findRelayPc(value));
    });
  };
  const match = (ticket: string) => void run(async () => {
    try { added((await addFoundRelayPc(ticket)).machine); } finally { setFound(null); }
  });
  if (found !== null) {
    const pc = found.name ?? t("this PC");
    return (
      <SettingsRow label={t("Does {name}'s screen show this ID?", { name: pc })} description={t("Compare it with the ID at the top of My devices on {name}. Pair only if every group matches.", { name: pc })} held wide>
        <div className="relay-pc-found">
          <KeyId id={found.server_id} label={t("ID of the PC this code found")} />
          <div className="relay-pc-actions">
            <button type="button" className="btn btn-primary" disabled={busy} aria-busy={busy || undefined} onClick={() => match(found.ticket)}>{t("It matches")}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setFound(null)}>{t("Cancel")}</button>
          </div>
        </div>
      </SettingsRow>
    );
  }
  return (
    <>
      <SettingsRow label={t("Code from another PC")} description={t("The code that PC shows under Connect a device.")} wide>
        <form className="relay-pc-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <input ref={input} className="input relay-pc-input" type="text" placeholder={t("Link or code")} aria-label={t("Pairing link or code")}
            autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={busy} />
          <button type="submit" className="btn" disabled={busy} aria-busy={busy || undefined} aria-label={t("Add a PC through the relay")}>{t("Add PC")}</button>
        </form>
      </SettingsRow>
      {result && <p className="settings-item settings-hint" role={result.error ? "alert" : "status"}>{result.text}</p>}
    </>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Pencil, RefreshCw, Trash2, X } from "lucide-react";

import "./DevicesPanel.css";

import { ApiError, fetchDevices, pairDevice, renameDevice, revokeAllDevices, revokeDevice, startPairing } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { deviceLabel } from "../lib/phone.ts";
import type { HealthAuth, PairedDevice, PairingCode } from "../../shared/protocol.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { QrCode } from "./QrCode.tsx";
import { SettingsRow } from "./SettingsControls.tsx";
import { currentLocale, t as tt, useT } from "../lib/i18n.ts";

const POLL_MS = 3000;

export interface DevicesPanelProps {
  /** an address the phone can open right now (Settings → Phone knows it), for the QR code; null shows the code alone */
  pairUrl: string | null;
  /** how this browser got in */
  auth: HealthAuth | null;
  /** after this browser paired itself: the health check tells the rest of the app */
  onPaired?: () => void;
  /** after every device was revoked, this browser's own pairing included: the app asks the server where it stands */
  onRevokedAll?: () => void;
}

export const VIA: Record<NonNullable<HealthAuth["via"]>, string> = {
  local: "You are on the PC itself.",
  tailscale: "You are in as this PC's Tailscale login.",
  device: "This is a paired device.",
  token: "You are in with the access token.",
  open: "This browser is in only because nothing is paired yet: from anywhere that can reach this address, so would anyone.",
};

function lastSeen(value: string | null): string {
  if (value === null) return tt("never");
  const minutes = Math.round((Date.now() - Date.parse(value)) / 60_000);
  if (minutes < 2) return tt("just now");
  if (minutes < 60) return tt("{n} min ago", { n: minutes });
  if (minutes < 60 * 48) return tt("{n} h ago", { n: Math.round(minutes / 60) });
  return new Date(value).toLocaleDateString(currentLocale());
}

/** Settings → Devices: the paired devices, and a code to pair one more. */
export function DevicesPanel({ pairUrl, auth, onPaired, onRevokedAll }: DevicesPanelProps) {
  const t = useT();
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** the demo, or an older server: there is no device list here */
  const [unavailable, setUnavailable] = useState(false);
  const [code, setCode] = useState<PairingCode | null>(null);
  const [left, setLeft] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  /** the question before every device goes; its answer, once they are gone */
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [revokedAll, setRevokedAll] = useState(false);
  const [justPaired, setJustPaired] = useState<string | null>(null);
  const [pairingSelf, setPairingSelf] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const known = useRef(new Set<string>());
  /** whether the list was read once: from then on, every device not in `known` is one that just paired */
  const loaded = useRef(false);
  /** bumped when every device goes: a read started before that answers for a list that no longer exists */
  const generation = useRef(0);
  const pairingSelfLock = useRef(false);

  const load = useCallback(async () => {
    const started = generation.current;
    try {
      const list = await fetchDevices();
      if (started !== generation.current) return;
      setDevices(list);
      setError(null);
      // a device that appeared while a code was out just paired with it
      const fresh = list.filter((d) => !known.current.has(d.id));
      if (loaded.current) for (const d of fresh) { setJustPaired(d.label); setCode(null); setRevokedAll(false); }
      known.current = new Set(list.map((d) => d.id));
      loaded.current = true;
    } catch (e) {
      if (started !== generation.current) return;
      setDevices([]);
      if (e instanceof ApiError && e.status === 404) setUnavailable(true);
      setError(e instanceof ApiError && e.status === 404 ? t("Devices are managed on a real server.") : e instanceof Error ? e.message : String(e));
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  // while a code is out: count it down, and watch for the device it lets in
  useEffect(() => {
    if (code === null) return;
    const tick = () => {
      const ms = Date.parse(code.expires_at) - Date.now();
      if (ms <= 0) { setCode(null); return; }
      setLeft(`${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    const poll = window.setInterval(() => void load(), POLL_MS);
    return () => { window.clearInterval(timer); window.clearInterval(poll); };
  }, [code, load]);

  const pair = async () => {
    setJustPaired(null);
    setRevokedAll(false);
    try { setCode(await startPairing()); setError(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  /** an "open" browser pairs itself: a code, used at once, so the gate closes to everyone else */
  const pairSelf = async () => {
    if (pairingSelfLock.current) return;
    pairingSelfLock.current = true;
    setPairingSelf(true);
    setError(null);
    try {
      const fresh = await startPairing();
      await pairDevice(fresh.code, deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0));
      const list = await fetchDevices();
      const current = list.find((device) => device.current);
      setDevices(list);
      known.current = new Set(list.map((device) => device.id));
      if (!current) {
        setError(t("Could not confirm this browser is paired. Check that cookies are enabled, then try again."));
        return;
      }
      setJustPaired(current.label);
      onPaired?.();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally {
      pairingSelfLock.current = false;
      setPairingSelf(false);
    }
  };
  const rename = async () => {
    if (!renaming) return;
    try { await renameDevice(renaming.id, renaming.label); setRenaming(null); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const revoke = async (id: string) => {
    if (confirming !== id) { setConfirming(id); window.setTimeout(() => setConfirming((c) => (c === id ? null : c)), 4000); return; }
    setConfirming(null);
    setRevokedAll(false);
    try { await revokeDevice(id); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  /**
   * One request ends every pairing, this browser's included (the server clears its device cookie).
   * A failure stays in the dialog; after a success nothing is asked of the server again from here:
   * a browser that was in as a device is out now, and the app finds that out through `onRevokedAll`.
   */
  const revokeAll = async () => {
    try { await revokeAllDevices(); } catch (e) {
      // no answer from the server (the connection dropped, the answer did not parse): the write may have
      // happened, so nothing is promised; the list is read again to show what is still paired
      if (!(e instanceof ApiError)) {
        void load();
        throw new Error(t("The PC did not answer, so it is not known whether the devices were revoked. Check the list, and try again if they are still there."));
      }
      // the dialog shows this: what did not happen, why in words, and what to do next; a server fault
      // carries its log reference (`internal error (<id>)`), never a file name or a stack
      const detail = e.detail;
      const reference = e.status >= 500 ? /\(([^()]+)\)\s*$/.exec(detail)?.[1] : undefined;
      throw new Error(reference !== undefined
        ? t("Nothing was revoked: the PC could not save the change. Try again; if it keeps failing, look up {reference} in the server's log on the PC.", { reference })
        : t("Nothing was revoked ({reason}). Try again.", { reason: detail }));
    }
    generation.current += 1;
    setConfirmingAll(false);
    setDevices([]);
    known.current = new Set();
    setCode(null);
    setJustPaired(null);
    setError(null);
    setRevokedAll(true);
    onRevokedAll?.();
  };
  /** a watching device reads this page and changes nothing on it */
  const watching = auth?.role === "watch";

  const spaced = code ? `${code.code.slice(0, 3)} ${code.code.slice(3)}` : "";
  const qrValue = code && pairUrl ? `${pairUrl.replace(/\/$/, "")}/?pair=${code.code}` : null;

  return (
    <div className="devices-panel">
      {auth?.via !== undefined && <p className={auth.via === "open" ? "settings-hint devices-open" : "settings-description"}>{t(VIA[auth.via])}</p>}
      {auth?.via === "open" && <>
        <p className="settings-hint">{t("Pairing a device turns on the app's own sign-in, on top of any proxy sign-in: other browsers then need pairing or the access token. If your proxy already signs people in, set OVIS_TOKEN and have the proxy send it instead.")}</p>
        <div className="phone-actions"><button type="button" className="btn btn-primary" onClick={() => void pairSelf()} disabled={pairingSelf}>{t("Pair this device now")}</button></div>
      </>}
      <details className="settings-details">
        <summary>{t("A paired device gets in on its own until you revoke it here.")}<span className="settings-details-toggle">{t("Details")}</span></summary>
        <p className="settings-hint">{t("It gets in from anywhere it can reach this server. A code comes from this screen on the PC or on a device already paired, or from the pair command in the PC's terminal.")}</p>
      </details>
      {devices === null ? <p className="settings-hint" role="status">{t("Loading…")}</p> : devices.length === 0 ? (
        <p className="settings-hint">{t("No devices paired yet.")}</p>
      ) : (
        <ul className="devices-list">
          {devices.map((d) => (
            <li key={d.id} className="devices-row">
              {renaming?.id === d.id ? (
                <form className="devices-rename" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
                  <input className="input" value={renaming.label} maxLength={48} autoFocus aria-label={t("Device name")} onChange={(e) => setRenaming({ id: d.id, label: e.target.value })} />
                  <button type="submit" className="icon-button" aria-label={t("Save name")}><Check /></button>
                  <button type="button" className="icon-button" aria-label={t("Cancel")} onClick={() => setRenaming(null)}><X /></button>
                </form>
              ) : (
                <>
                  <div className="devices-name">
                    <span className="settings-label">{d.label}{d.current && <span className="devices-current">{t("this device")}</span>}</span>
                    <span className="settings-description">{t("Last seen {when}", { when: lastSeen(d.last_seen_at) })}</span>
                  </div>
                  <div className="devices-actions">
                    <button type="button" className="icon-button" aria-label={t("Rename {name}", { name: d.label })} onClick={() => setRenaming({ id: d.id, label: d.label })}><Pencil /></button>
                    {/* one element across both steps, so focus stays on it when it asks to confirm */}
                    <button type="button" className={confirming === d.id ? "btn btn-danger" : "icon-button"} aria-label={confirming === d.id ? undefined : t("Revoke {name}", { name: d.label })} onClick={() => void revoke(d.id)}>
                      <Trash2 aria-hidden="true" />{confirming === d.id && t("Revoke?")}
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {justPaired !== null && <p className="settings-hint" role="status">{t("Paired: {name}.", { name: justPaired })}</p>}
      {revokedAll && <p className="settings-hint" role="status">{t("Every paired device was revoked. The access token, this PC and its Tailscale login get in as before.")}</p>}
      {code === null ? (
        <div className="phone-actions"><button type="button" className="btn btn-primary" onClick={() => void pair()} disabled={unavailable}>{t("Pair a device")}</button></div>
      ) : (
        <div className="devices-pairing" role="status">
          {qrValue !== null && <QrCode value={qrValue} label={t("QR code that pairs a phone with code {code}", { code: code.code })} />}
          <div>
            <p className="settings-label">{t("On the other device, enter this code")}</p>
            <p className="devices-code">{spaced}</p>
            <p className="settings-description">
              {t(qrValue !== null ? "Or scan the QR code: it opens the app with the code filled in." : "Open the app's address on that device and enter it.")} {t("Expires in {time}.", { time: left })}
            </p>
            {qrValue !== null && (
              <p className="devices-link">
                <span className="settings-description">{t("Or send this link to it:")}</span>
                <a ref={linkRef} href={qrValue}>{qrValue}</a>
                <button type="button" className="btn btn-ghost" onClick={() => void copyText(qrValue, linkRef.current).then((ok) => { if (ok) { setLinkCopied(true); window.setTimeout(() => setLinkCopied(false), 1600); } })}>{t(linkCopied ? "Copied" : "Copy")}</button>
              </p>
            )}
            <div className="phone-actions">
              <button type="button" className="btn" onClick={() => void pair()}><RefreshCw aria-hidden="true" />{t("New code")}</button>
              <button type="button" className="btn btn-ghost" onClick={() => setCode(null)}>{t("Done")}</button>
            </div>
          </div>
        </div>
      )}
      {devices !== null && devices.length > 0 && (
        <div className="devices-revoke-all">
          <SettingsRow label={t("Revoke every device")} description={t(watching
            ? "Every paired device, this one included, would lose its pairing access at once. A device that only watches cannot do it: use the PC or a device that can drive."
            : "Every paired device, this one included, loses its pairing access at once. The access token, this PC and its Tailscale login are not affected.")}>
            {/* a watching device reads why and has no button: a dead control would only be a fainter one */}
            {!watching && <button type="button" className="btn" onClick={() => setConfirmingAll(true)}>{t("Revoke all")}</button>}
          </SettingsRow>
        </div>
      )}
      {confirmingAll && (
        <ConfirmDialog title={t("Revoke every paired device?")}
          body={t("Every paired device loses its pairing access, this one included, and needs a new code to get back in. The access token, this PC and its Tailscale login still get in.")}
          confirmLabel={t("Revoke all")} onClose={() => setConfirmingAll(false)} onConfirm={revokeAll} />
      )}
      {error !== null && <p className="settings-hint" role="alert">{error}</p>}
    </div>
  );
}

import { useEffect, useState } from "react";
import { Share, Smartphone, X } from "lucide-react";

import "./InstallHint.css";

import { useInstallPrompt } from "../lib/install.ts";
import { installHintKind, readHintDismissed, writeHintDismissed } from "../lib/installHint.ts";
import { useT } from "../lib/i18n.ts";
import { inNativeApp } from "../lib/nativeApp.ts";

/**
 * One line on a phone's browser tab: add Ovis to the home screen, where alerts reach it (rules in
 * lib/installHint.ts). iPhone has no install prompt, so it names the steps with Safari's share
 * glyph; Android installs in one tap when Chrome offers its prompt, and names the menu item when
 * not. Like the Claude and ChatGPT web apps' install banners it is a single dismissible line,
 * not a dialog, and it never comes back once closed or installed.
 */
export function InstallHint() {
  const t = useT();
  const prompt = useInstallPrompt();
  const [dismissed, setDismissed] = useState(readHintDismissed);
  useEffect(() => {
    if (!prompt.installed) return;
    writeHintDismissed();
    setDismissed(true);
  }, [prompt.installed]);
  const kind = installHintKind({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    secure: window.isSecureContext,
    installed: prompt.installed,
    nativeApp: inNativeApp(),
    dismissed,
  });
  if (kind === null) return null;
  const dismiss = () => {
    writeHintDismissed();
    setDismissed(true);
  };
  const [before, after] = t("Add to Home Screen for alerts: {glyph} Share → Add to Home Screen").split("{glyph}");
  return (
    <div className="update-notice is-install" role="status" data-testid="install-hint" data-install-hint={kind}>
      <Smartphone aria-hidden="true" />
      {kind === "ios"
        ? <span>{before}<Share className="install-hint-glyph" aria-hidden="true" />{after}</span>
        : <span>{prompt.canInstall ? t("Install the app for alerts.") : t("Install the app for alerts: Menu → Install app")}</span>}
      <div className="install-hint-actions">
        {kind === "android" && prompt.canInstall && <button type="button" className="btn btn-primary" onClick={() => prompt.install().catch((error: unknown) => console.error("install prompt", error))}>{t("Install")}</button>}
        <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={dismiss}><X /></button>
      </div>
    </div>
  );
}

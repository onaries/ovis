import { useState } from "react";
import { Copy, RefreshCw } from "lucide-react";

import "./CompactPair.css";

import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import { QrCode } from "./QrCode.tsx";

const QR_SIZE = 132;

/**
 * One way into this PC as Connect a device shows it: the QR code a camera opens, the code to type
 * beside it, and only Refresh and Copy. `code` is what Copy copies; `shown` is how it reads (grouped).
 */
export function CompactPair({ qr, qrLabel, code, shown = code, codeLabel, busy = false, onRefresh }: {
  qr: string | null; qrLabel: string; code: string | null; shown?: string | null; codeLabel: string; busy?: boolean; onRefresh: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (code === null) return;
    void copyText(code).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };
  return (
    <div className="compact-pair">
      {qr !== null ? <QrCode value={qr} label={qrLabel} size={QR_SIZE} /> : <div className="compact-pair-qr-empty" aria-hidden="true" />}
      <div className="compact-pair-side">
        <p className="compact-pair-code" aria-label={codeLabel} aria-live="polite">{shown ?? "…"}</p>
        <div className="compact-pair-actions">
          <button type="button" className="btn" disabled={busy} aria-busy={busy || undefined} onClick={onRefresh}><RefreshCw aria-hidden="true" />{t("Refresh")}</button>
          <button type="button" className="btn" disabled={code === null} onClick={copy}><Copy aria-hidden="true" />{copied ? t("Copied") : t("Copy")}</button>
        </div>
      </div>
    </div>
  );
}

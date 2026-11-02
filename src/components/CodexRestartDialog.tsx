import { useEffect, useState } from "react";
import type { CodexRestartTarget } from "../../shared/protocol.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { userErrorMessage } from "../lib/userError.ts";
import { ApiError } from "../lib/api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

type Check = { kind: "checking" } | { kind: "ready"; target: CodexRestartTarget } | { kind: "error"; message: string };

export function CodexRestartDialog({ paneId, onClose, onRestarted }: { paneId: string; onClose: () => void; onRestarted: () => void }) {
  const api = useMachineApi();
  const t = useT();
  const [check, setCheck] = useState<Check>({ kind: "checking" });
  useEffect(() => {
    let active = true;
    setCheck({ kind: "checking" });
    void api.prepareCodexRestart(paneId).then((target) => {
      if (active) setCheck({ kind: "ready", target });
    }, (error: unknown) => {
      if (active) setCheck({ kind: "error", message: error instanceof ApiError ? error.detail : userErrorMessage(error).message });
    });
    return () => { active = false; };
  }, [api, paneId]);
  return <ConfirmDialog title={t("Restart Codex?")}
    body={check.kind === "checking" ? t("Checking the current Codex conversation…") : t("Codex will close and reopen the same conversation in this pane. Running work may be interrupted, and text left in the terminal input may be lost.")}
    confirmLabel={t("Restart Codex")} confirmDisabled={check.kind !== "ready"}
    errorMessage={check.kind === "error" ? check.message : undefined}
    onClose={onClose} onConfirm={async () => {
      if (check.kind !== "ready") return;
      await api.restartCodex(check.target);
      onRestarted();
      onClose();
    }} />;
}

/**
 * Devices asking to join the account through the PC this window is in (`remote-pairings`): the
 * first waits in AccountApprovalPrompt. An approval tells this PC first, which lets the device in
 * here; then this device signs the `add` for the account's other PCs and leaves the PCs it checked
 * itself with this PC as the new device's introduction (lib/account/join.ts).
 */
import { useEffect, useState } from "react";

import type { RemotePairingRequest } from "../../shared/protocol.ts";
import { admitToAccount, approveJoin, UnverifiedJoinError } from "../lib/account/join.ts";
import { useT } from "../lib/i18n.ts";
import { accountServiceOf, AccountService } from "../lib/account/service.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { decideRelayPairing } from "../lib/api.ts";
import { indexedDeviceStore } from "../lib/relay/device.ts";
import { serverIdOfPath } from "../lib/shellMode.ts";
import { getTransport } from "../lib/transport.ts";
import { AccountApprovalPrompt } from "./AccountApprovalPrompt.tsx";

export function AccountApprovals({ pairings }: { pairings: readonly RemotePairingRequest[] }) {
  const t = useT();
  const request = pairings[0];
  const serverId = serverIdOfPath(window.location.pathname);
  const [where, setWhere] = useState<{ pcName: string; pcCount: number }>({ pcName: "", pcCount: 1 });

  useEffect(() => {
    if (serverId === null) return;
    let live = true;
    void (async () => {
      const paired = await indexedDeviceStore.list();
      const here = paired.find((device) => device.server_id === serverId);
      const service = accountServiceOf(document);
      let count = paired.filter((device) => device.device_id !== null).length;
      if (service !== null) {
        try { count = Math.max(count, (await new AccountService({ store: indexedAccountStore }).listPcs()).length); }
        catch (error) { console.warn("Ovis: the account's PCs could not be counted", error instanceof Error ? error.name : error); }
      }
      if (live) setWhere({ pcName: here?.name ?? serverId.slice(0, 8), pcCount: Math.max(count, 1) });
    })();
    return () => { live = false; };
  }, [serverId]);

  if (request === undefined || serverId === null) return null;

  const decide = async (decision: "approve" | "decline", digits?: string): Promise<void> => {
    if (decision === "decline" || digits === undefined) { await decideRelayPairing(request.id, "decline"); return; }
    const service = new AccountService({ store: indexedAccountStore });
    const session = await service.session();
    // signed out here: answered on this PC only, never added to the account
    if (session === undefined || request.intent !== "account") { await decideRelayPairing(request.id, "approve", digits); return; }
    const transport = getTransport();
    try {
      await approveJoin({
        request, digits, through: serverId, service,
        decide: (answer, picked) => decideRelayPairing(request.id, answer, picked),
        admit: async () => admitToAccount({
          fetch: (path, init) => transport.fetch(path, init), service, key: await indexedAccountStore.key(), account: session.account,
          joining: { key: request.key, label: request.label }, through: serverId, paired: await indexedDeviceStore.list(),
          directory: (await service.listPcs()).map((pc) => pc.server_id), store: indexedAccountStore,
        }),
      });
    } catch (error) {
      if (error instanceof UnverifiedJoinError) throw new Error(t("Could not verify this device. It was declined: approve only a device you are signing in yourself."));
      throw error;
    }
  };

  return <AccountApprovalPrompt key={request.id} request={request} pcName={where.pcName} pcCount={where.pcCount} onDecide={decide} />;
}

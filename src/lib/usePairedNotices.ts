import { useCallback, useState } from "react";
import type { DevicePairedEvent, DeviceRemovedEvent, RelayPairingRequest, RemotePairingRequest } from "../../shared/machines.ts";

export function usePairedNotices() {
  const [pairedNotices, setPairedNotices] = useState<readonly DevicePairedEvent[]>([]);
  const [relayPairings, setRelayPairings] = useState<readonly RelayPairingRequest[]>([]);
  /** devices asking to join the account through this PC, for this device to approve as a member (components/AccountApprovals.tsx) */
  const [remotePairings, setRemotePairings] = useState<readonly RemotePairingRequest[]>([]);
  const [removedNotices, setRemovedNotices] = useState<readonly DeviceRemovedEvent[]>([]);
  const dismissRemovedNotice = useCallback((event: DeviceRemovedEvent) => setRemovedNotices((list) => list.filter((item) => item.event_id !== event.event_id)), []);
  const dismissPairedNotice = useCallback((event: DevicePairedEvent) => setPairedNotices((list) => list.filter((item) => item.event_id !== event.event_id)), []);
  return { pairedNotices, setPairedNotices, dismissPairedNotice, relayPairings, setRelayPairings, remotePairings, setRemotePairings, removedNotices, setRemovedNotices, dismissRemovedNotice };
}

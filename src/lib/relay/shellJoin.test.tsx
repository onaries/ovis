import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import type { MyPc } from "../account/myPcs.ts";
import { memoryAccountStore } from "../account/store.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import type { RelayDeviceStore } from "./device.ts";
import { mountRelayShell } from "./shell.tsx";
import { createShellTestPage } from "./shell.test.tsx";
import type { RelayShellMount } from "./shellState.ts";

describe("explicit dashboard pairing consent", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  beforeEach(() => { browser = createShellTestPage(); browser.setVisibility("hidden"); });
  afterEach(() => { setTransport(nativeTransport); browser.dispose(); });

  it.each(["new", "join"] as const)("starts the %s sheet's comparison after one confirmation", async (mode) => {
    const identity = generateKeyPair();
    const pc: MyPc = {
      server_id: deriveServerId(identity.publicKey), name: "Desk", state: "needs-approval",
      last_seen_at: null, added_at: null, listed: true, paired: false, linked: false,
      join: { server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.ovis.sh" },
    };
    const paths: string[] = [];
    let props: RelayShellProps | undefined;
    const render = (node: ReactNode): void => {
      if (!isValidElement<{ readonly children?: ReactNode }>(node)) throw new TypeError("Missing shell element");
      if (node.type === RelayShell && isValidElement<RelayShellProps>(node)) { props = node.props; return; }
      render(node.props.children);
    };
    const current = (): RelayShellProps => { if (!props) throw new TypeError("Missing shell props"); return props; };
    const store: RelayDeviceStore = {
      get: async () => undefined, list: async () => [], remove: async () => {},
      update: async () => { throw new TypeError("Pairing has not been approved by the PC"); },
    };
    const compared = Promise.withResolvers<void>();
    const mount: RelayShellMount = {
      container: Object.create(null), entryUrl: "https://app.ovis.sh/", shellVersion: "1.0.0",
      store, label: "Phone", accountStore: memoryAccountStore(), accountService: "https://account.ovis.sh",
      accountFetch: async () => Response.json({ pcs: [] }),
      createRoot: () => ({ render, unmount() {} }),
      renderApp: () => { throw new TypeError("Pairing has not finished"); },
      navigate: (path) => { paths.push(path); },
      open: async (_offer, options) => {
        if (!options?.compare) throw new TypeError("Pairing must require a PC comparison");
        const pending = options.compare("123456");
        compared.resolve();
        await pending;
        throw new TypeError("The test must not approve the comparison");
      },
    };
    await mountRelayShell(mount);
    const join = current().onJoin;
    if (!join) throw new TypeError("Account pairing action is missing");

    join(pc, { sheet: mode, typed: mode === "new" });
    const path = paths[0];
    if (!path) throw new TypeError("The selected PC did not receive a scoped navigation");
    await mountRelayShell({ ...mount, entryUrl: new URL(path, mount.entryUrl).href });

    expect(current().state.kind).not.toBe("confirm");
    await compared.promise;
    const state = current().state;
    expect(state).toMatchObject({ kind: "compare", confirmed: false });
    expect(state.kind === "compare" && state.typed === true).toBe(mode === "new");
    expect(current().sheetJoin).toMatchObject({ mode, server_id: pc.server_id });
    current().onCancel();
    await mountRelayShell({ ...mount, entryUrl: new URL(path, mount.entryUrl).href });
    expect(current().state.kind).toBe("confirm");
  });
});

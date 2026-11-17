import { contextBridge, ipcRenderer } from "electron";
import { linkHold } from "./openLink.ts";

// the update the app has downloaded (main.ts UpdateLine, or null), for the connection screen and the
// server's pages alike: main answers only those
contextBridge.exposeInMainWorld("ovisUpdate", {
  current: (): Promise<unknown> => ipcRenderer.invoke("ovis:update"),
  /** returns what stops the listening */
  onChange: (listener: (update: unknown) => void): (() => void) => {
    const heard = (_event: unknown, update: unknown) => listener(update);
    ipcRenderer.on("ovis:update", heard);
    return () => { ipcRenderer.removeListener("ovis:update", heard); };
  },
  /** Restart to Update; settles only when Ovis keeps running after it (a .deb's password prompt cancelled) */
  install: (): Promise<void> => ipcRenderer.invoke("ovis:update-install"),
  /** closes the line of that version */
  close: (version: string): void => ipcRenderer.send("ovis:update-close", version),
});

// only the app's own connection screen gets the bridge, never a page the server serves
if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("ovisDesktop", {
    status: () => ipcRenderer.invoke("ovis:status"),
    onStatus: (listener: (status: unknown) => void) => {
      ipcRenderer.on("ovis:status", (_event, status: unknown) => listener(status));
    },
    retry: () => ipcRenderer.send("ovis:retry"),
    showLogs: () => ipcRenderer.send("ovis:logs"),
  });
} else {
  // the pane an ovis:// link names (main.ts openLink, openLink.ts), as a query of the deep link's
  // names: main tells only its own server's page, as soon as it has loaded, so the one link that
  // came before the page listens is held for it (openLink.ts linkHold)
  const links = linkHold();
  ipcRenderer.on("ovis:open-link", (_event, query: unknown) => links.receive(query));
  contextBridge.exposeInMainWorld("ovisLink", {
    onOpen: (listener: (query: string) => void): void => links.onOpen(listener),
  });
  // the server's pages sign in to the account through the system browser (src/accountSignIn.ts);
  // main answers only its own server's pages, and only while an account service is named
  const named = ipcRenderer.sendSync("ovis:account-service") as { service?: unknown; providers?: unknown } | null;
  if (typeof named?.service === "string") {
    contextBridge.exposeInMainWorld("ovisAccount", {
      service: named.service,
      providers: Array.isArray(named.providers) ? named.providers.filter((name): name is string => typeof name === "string") : [],
      start: (): Promise<string> => ipcRenderer.invoke("ovis:account-start"),
      open: (url: string): Promise<string> => ipcRenderer.invoke("ovis:account-open", url),
    });
  }
}

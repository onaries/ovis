import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { UsageProviderId } from "../shared/protocol.ts";
import type { UsageLoginStarted } from "../shared/usage-login.ts";
import { paneClose, paneProcessInfo, paneSendKeys, paneSendText, sessionSnapshot, tabCreate, workspaceCreate } from "./herdr/client.ts";
import { badRequest, conflictResponse, errorResponse, isJsonObject, jsonResponse } from "./http.ts";
import { psQuote } from "./powershell.ts";
import { withOwnerGuard } from "./owner-guard.ts";
import { writePrivateState } from "./private-state.ts";
import { paneShell, shellCommandLine, type PaneShell } from "./shell-agent.ts";
import { localSignInPlace, systemUsageContext, USAGE_PROVIDERS, type UsageContext } from "./usage.ts";

const LOGIN = {
  claude: { cli: "claude", binaries: ["claude"], args: ["auth", "login"] },
  codex: { cli: "codex", binaries: ["codex"], args: ["login"] },
  cursor: { cli: "Cursor CLI (agent)", binaries: ["agent", "cursor-agent"], args: ["login"] },
  copilot: { cli: "GitHub CLI (gh)", binaries: ["gh"], args: ["auth", "login", "--hostname", "github.com"] },
  grok: { cli: "grok", binaries: ["grok"], args: ["login"] },
  antigravity: { cli: "Antigravity CLI (agy)", binaries: ["agy"], args: null },
  opencode: { cli: "opencode", binaries: ["opencode"], args: ["auth", "login"] },
} as const;

/**
 * What the sign-in line sets first in `shell`: the credential home `name` names (`home`), or none
 * (null: the default home). The pane's shell may have inherited another account's home, so the
 * default one is reached by removing the variable, not by leaving it out of the tab's environment.
 */
function credentialHomePrefix(shell: PaneShell, name: string, home: string | null): string {
  if (shell === "posix") return `${shellCommandLine("posix", "env", home === null ? ["-u", name] : [`${name}=${home}`])} `;
  if (shell === "powershell") return home === null ? `Remove-Item Env:${name} -ErrorAction SilentlyContinue; ` : `$env:${name} = ${psQuote(home)}; `;
  if (/["%\r\n]/.test(home ?? "")) throw new Error("this credential home cannot be typed into cmd.exe");
  return `set "${name}=${home ?? ""}" & `;
}

/**
 * One directory's one name, however it is reached: its real path through any symlink, or for a home
 * not made yet, its nearest existing parent's real path and the rest. Two logins locked by spelling
 * would both write one home reached through an alias. Throws when it cannot be told (a directory it
 * may not read): a guess would let a second login in.
 */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
  }
}

/**
 * The login holding a credential home: the pane its tab opened as, and that tab's terminal. herdr names
 * each terminal once and keeps the name when the tab moves to another workspace (its pane ID changes), so
 * the terminal is there exactly as long as the login runs in it: the CLI replaces the tab's shell (exec),
 * or the shell exits after it. A pane ID alone is no proof: a restarted herdr hands the same IDs out again.
 */
interface LoginHolder { readonly pane: string; readonly terminal: string }
/** A home taken for a launch whose tab has not opened yet: by which server process, since when, and the launch's own id. */
interface Launch { readonly launch: string; readonly pid: number; readonly at: number }
type Holder = LoginHolder | Launch;

/** A launch opens its tab within the request's 30 s, the CLI's help taking up to 10 of them: one older has failed. */
const LAUNCH_MS = 60_000;

const isLaunch = (holder: Holder): holder is Launch => "launch" in holder;
const sameHolder = (a: Holder, b: Holder): boolean => isLaunch(a) ? isLaunch(b) && a.launch === b.launch : !isLaunch(b) && a.terminal === b.terminal;

/** The file of running sign-ins exists but cannot be read or understood: it may name one still running. */
class LoginStateUnreadable extends Error {
  constructor(file: string, cause: unknown) {
    super(`${file} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "LoginStateUnreadable";
  }
}

/** Whether a process still runs (one of another user is still running too). */
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error instanceof Error && "code" in error && error.code === "EPERM"; }
}

/** Only panes this service launched invalidate usage when their login process exits. */
export class UsageLoginService {
  private readonly panes = new Set<string>();
  /**
   * One login at a time per credential home, Add account and Sign in again alike: two CLIs writing
   * one home race each other's tokens. By home, the login or launch of this server holding it.
   */
  private readonly logins = new Map<string, Holder>();
  /**
   * Where every server on this state dir keeps the homes taken, for the others and for the next one: a
   * login runs in a herdr tab, which outlives the server that opened it (#2313). Under the file's guard,
   * each server adds and removes its own entries, and takes over only one it found ended unchanged;
   * whether an entry still holds, herdr says.
   */
  private file: string | null = null;

  constructor(private readonly home = homedir(), private readonly env = process.env,
    private readonly context: UsageContext = { ...systemUsageContext(), home, env }) {}

  ended(paneId: string): boolean {
    for (const [home, holder] of this.logins) if (!isLaunch(holder) && holder.pane === paneId) this.release(home, holder);
    return this.panes.delete(paneId);
  }

  persistTo(stateDir: string): void { this.file = join(stateDir, "usage-logins.json"); }

  /**
   * The homes the file names as taken; none when there is no file yet. A file that will not read or parse
   * throws LoginStateUnreadable: it may name a sign-in still running, so it authorizes no other.
   */
  private read(file: string): Map<string, Holder> {
    const found = new Map<string, Holder>();
    let text: string;
    try { text = readFileSync(file, "utf8"); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return found;
      throw new LoginStateUnreadable(file, error);
    }
    let saved: unknown;
    try { saved = JSON.parse(text); } catch (error) { throw new LoginStateUnreadable(file, error); }
    if (!isJsonObject(saved) || !Array.isArray(saved["logins"])) throw new LoginStateUnreadable(file, "no list of sign-ins");
    for (const entry of saved["logins"]) {
      if (!isJsonObject(entry) || typeof entry["home"] !== "string") throw new LoginStateUnreadable(file, "a sign-in without its home");
      const { home, pane, terminal, launch, pid, at } = entry;
      if (typeof pane === "string" && typeof terminal === "string") found.set(home, { pane, terminal });
      else if (typeof launch === "string" && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && typeof at === "number" && Number.isFinite(at)) found.set(home, { launch, pid, at });
      else throw new LoginStateUnreadable(file, "a sign-in it cannot tell");
    }
    return found;
  }

  /**
   * Reads, changes and writes the file as one step no other server's edit comes between; without a file,
   * `change` sees none. Throws when the guard cannot be taken or released or the file cannot be written:
   * a sign-in no other server can see could run beside another.
   */
  private edit<T>(change: (saved: Map<string, Holder>) => T): T {
    const file = this.file;
    if (file === null) return change(new Map());
    return withOwnerGuard(file, () => {
      const saved = this.read(file);
      const before = JSON.stringify([...saved]);
      const result = change(saved);
      if (JSON.stringify([...saved]) !== before) {
        const written = writePrivateState(file, { logins: [...saved].map(([home, holder]) => ({ home, ...holder })) });
        // a rename the directory did not record may be gone after a crash (Windows does not sync a directory)
        if (!written.directorySynced && process.platform !== "win32") throw new Error(`${file} was written, but its directory could not be synced`);
      }
      return result;
    });
  }

  /** Frees `home` from `holder`, here and in the file, wherever another has not taken it since. */
  private release(home: string, holder: Holder): void {
    if (this.logins.get(home) === holder) this.logins.delete(home);
    // left in the file, it holds only until another server finds it ended
    try { this.edit((saved) => { const now = saved.get(home); if (now !== undefined && sameHolder(now, holder)) saved.delete(home); }); }
    catch (error) { console.warn("Could not free a sign-in's credential home for other servers", error); }
  }

  /**
   * Whether `holder` still holds: a launch while its server runs and it is young enough to open its tab,
   * a login while its terminal is in herdr, in any tab. When herdr cannot say, it holds: a guess would let
   * a second login in.
   */
  private async holds(holder: Holder): Promise<boolean> {
    if (isLaunch(holder)) return Date.now() - holder.at <= LAUNCH_MS && processAlive(holder.pid);
    try { return (await sessionSnapshot()).panes.some((pane) => pane.terminal_id === holder.terminal); }
    catch { return true; }
  }

  /**
   * Takes `home` for one launch, in the file too before anything is awaited, so neither this server nor
   * another starts a second; null while a login or launch holds it. A holder lets go once `holds()` finds
   * it ended: its exit went unseen, it ended while no server ran, or its server stopped mid-launch.
   */
  private async reserve(home: string): Promise<Launch | null> {
    // the file's holder found ended: taken over in the step that finds it unchanged, so a file that cannot
    // be written never brings it back for another look
    let ended: Holder | undefined;
    for (;;) {
      const own = this.logins.get(home);
      if (own !== undefined) {
        if (await this.holds(own)) return null;
        this.release(home, own);
        continue;
      }
      const launch: Launch = { launch: randomUUID(), pid: process.pid, at: Date.now() };
      let holder: Holder | undefined;
      try {
        holder = this.edit((saved) => {
          const found = saved.get(home);
          if (found !== undefined && !(ended !== undefined && sameHolder(found, ended))) return found;
          saved.set(home, launch);
          return undefined;
        });
      } catch (error) {
        // a claim written but not made durable holds nothing: take it back where it landed
        if (!(error instanceof LoginStateUnreadable)) this.release(home, launch);
        throw error;
      }
      if (holder === undefined) { this.logins.set(home, launch); return launch; }
      if (await this.holds(holder)) return null;
      ended = holder;
    }
  }

  async handle(request: Request, trackPane?: (paneId: string) => void): Promise<Response> {
    const executableFor = (id: UsageProviderId) => LOGIN[id].binaries.map((cli) => Bun.which(cli, { PATH: this.env["PATH"] ?? "" })).find(Boolean);
    if (request.method === "GET") {
      const id = new URL(request.url).searchParams.get("provider");
      if (id !== null) {
        const provider = USAGE_PROVIDERS.find((provider) => provider.id === id);
        if (!provider) return badRequest("invalid_provider", "Unknown usage provider");
        try {
          const found = await provider.signIns(this.context);
          return jsonResponse({ accounts: found.map((signIn) => signIn.account?.label ?? signIn.account?.id ?? null) });
        } catch (error) { return errorResponse(error); }
      }
      return jsonResponse({ providers: USAGE_PROVIDERS.map(({ id }) => ({
        id, cli: LOGIN[id].cli, installed: Boolean(executableFor(id)), local: LOGIN[id].args !== null,
        separate_home: id === "claude" || id === "codex",
      })) });
    }
    if (request.method !== "POST") return badRequest("method_not_allowed", "Use GET or POST");
    let body: unknown;
    try { body = await request.json(); } catch { return badRequest("invalid_json", "Request body must be JSON"); }
    const provider = isJsonObject(body) ? USAGE_PROVIDERS.find(({ id }) => id === body["provider"]) : undefined;
    if (!provider || !isJsonObject(body)) return badRequest("invalid_provider", "Unknown usage provider");
    const id = provider.id;
    const separate = id === "claude" || id === "codex";
    // Signing in again names a listed account by its key; its credential home is the server's to find.
    const again = body["account"] !== undefined;
    if (again) {
      // only Claude's and Codex's CLIs sign in to a credential home the server can name
      if (!separate || typeof body["account"] !== "string" || body["account"].length > 256 || body["name"] !== undefined || body["replace"] !== undefined) {
        return badRequest("invalid_account", "Name one account this PC lists to sign in to it again");
      }
    } else if (separate ? typeof body["name"] !== "string" || !/^[a-z0-9-]{1,32}$/.test(body["name"])
      : body["name"] !== undefined || (body["replace"] !== undefined && body["replace"] !== true)) {
      return badRequest("invalid_account_name", "Use 1–32 lowercase letters, numbers or hyphens for the account name");
    }
    const login = LOGIN[id];
    if (login.args === null) return conflictResponse("login_not_supported", "Sign in interactively in Antigravity on the server PC");
    // POSIX exec lets herdr's pane-ended event identify completion, without a second watcher.
    const executable = executableFor(id);
    if (!executable) return conflictResponse("cli_unavailable", "Install the official CLI on this PC before signing in");
    let unusedCredentialHome: string | null = null;
    let reserved: string | null = null;
    // what holds the home for this request, its launch and then its login, which only this request may replace or free
    let holding: Holder | null = null;
    try {
      // read from the sign-ins on disk now, not a cached report: a home may hold another account since
      const found = again && typeof body["account"] === "string" ? await localSignInPlace(this.context, body["account"]) : null;
      if (again && found?.provider !== id) {
        return jsonResponse({ error: { code: "account_not_found", message: "This PC no longer lists that account. Refresh and try again." } }, 404);
      }
      if (found && "ambiguous" in found) {
        return conflictResponse("account_ambiguous", "This account is signed in in more than one credential folder on this PC, so Ovis cannot tell which one to renew. Sign in again from a terminal in the folder you want.");
      }
      const place = found;
      if (!separate && !again && body["replace"] !== true && (await provider.signIns(this.context)).length > 0) {
        return conflictResponse("account_confirmation_required", "Confirm before signing in again to this provider");
      }
      // the home the CLI will write: the account's own, a new named one, or the provider's only one
      let loginHome: string;
      try {
        loginHome = place ? `${id}:${canonicalPath(place.home.kind === "dir" ? place.home.dir : join(this.home, id === "claude" ? ".claude" : ".codex"))}`
          : separate ? `${id}:${canonicalPath(join(this.home, `.${id}-${body["name"]}`))}` : id;
      } catch (error) {
        console.warn("Could not tell which credential home a sign-in would write", error);
        return conflictResponse("credential_home_unreadable", "Ovis cannot read this account's credential folder, so it cannot tell whether a sign-in is already running there. Check the folder's permissions on the server PC.");
      }
      try { holding = await this.reserve(loginHome); }
      catch (error) {
        if (!(error instanceof LoginStateUnreadable)) throw error;
        console.warn("Could not read the sign-ins running in herdr tabs", error);
        return conflictResponse("login_state_unreadable", "Ovis cannot read its record of the sign-ins running on this PC (usage-logins.json in its state folder), so it cannot tell whether one is already open for this account. Close any sign-in tab still open, then repair or remove that file on the server PC.");
      }
      if (holding === null) {
        return conflictResponse("login_in_progress", "A sign-in to this account is already open in a terminal tab. Finish or close it first.");
      }
      reserved = loginHome;
      const help = Bun.spawn([executable, ...(id === "claude" ? ["auth"] : login.args), "--help"], {
        env: this.env, stdout: "pipe", stderr: "ignore", signal: AbortSignal.timeout(10_000),
      });
      const text = await new Response(help.stdout).text();
      const success = await help.exited === 0;
      const manual = id === "claude" && !(success && /\blogin\b/.test(text));
      const device = (id === "codex" || id === "grok") && success && text.includes("--device-auth");
      const args = manual ? [] : [...login.args, ...(device ? ["--device-auth"] : [])];
      // the browser that asked has gone (it gives up after 30 s): open no tab it would not see
      if (request.signal.aborted) return conflictResponse("request_cancelled", "The sign-in request was cancelled");
      const env: Record<string, string> = { HOME: this.home };
      if (process.platform === "win32") env["USERPROFILE"] = this.home;
      const homeVariable = id === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
      // the account's own home, where its expired sign-in is replaced; null is the default home
      const againHome = place?.home.kind === "dir" ? place.home.dir : null;
      if (place) {
        if (againHome !== null) env[homeVariable] = againHome;
      } else if (separate) {
        const credentialHome = join(this.home, `.${id}-${body["name"]}`);
        try { mkdirSync(credentialHome, { mode: 0o700 }); }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "EEXIST") return conflictResponse("account_exists", "That account name already has a credential home. Choose another name.");
          throw error;
        }
        unusedCredentialHome = credentialHome;
        env[id === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] = credentialHome;
      }
      if (id === "copilot") env["XDG_CONFIG_HOME"] = this.env["XDG_CONFIG_HOME"] || join(this.home, ".config");
      if (id === "cursor") env["NO_OPEN_BROWSER"] = "1";
      if (id === "copilot" && this.env["GH_CONFIG_DIR"]) env["GH_CONFIG_DIR"] = this.env["GH_CONFIG_DIR"];
      if (id === "opencode") env["XDG_DATA_HOME"] = this.env["XDG_DATA_HOME"] || join(this.home, ".local", "share");
      const snapshot = await sessionSnapshot();
      if (request.signal.aborted) return conflictResponse("request_cancelled", "The sign-in request was cancelled");
      const workspace = snapshot.workspaces[0];
      const options = {
        // a home given as a relative path was found from this server's directory, and means it there
        cwd: againHome !== null && !isAbsolute(againHome) ? process.cwd() : this.home, label: again ? `${id} sign-in again` : `${id} sign-in${separate ? ` · ${body["name"]}` : ""}`, env,
      };
      const created = workspace ? await tabCreate({ ...options, workspaceId: workspace.workspace_id }) : await workspaceCreate(options);
      const paneId = created.root_pane.pane_id;
      this.panes.add(paneId);
      trackPane?.(paneId);
      // the tab is open: from here on its terminal holds the home, also for a server started again. The
      // login is sent only once the file says so: run under a launch entry that expires, or one another
      // server took over, it could run beside another sign-in after a restart.
      const launch = holding;
      const opened: LoginHolder = { pane: paneId, terminal: created.root_pane.terminal_id };
      const home = reserved;
      let recorded = false;
      try {
        recorded = this.edit((saved) => {
          const now = saved.get(home);
          if (now !== undefined && !sameHolder(now, launch)) return false;
          saved.set(home, opened);
          return true;
        });
      } catch (error) {
        // a record written but not made durable holds nothing: take it back where it landed
        this.release(home, opened);
        await paneClose(paneId).catch((closeError: unknown) => console.warn("Could not close a sign-in tab whose login was not sent", closeError));
        throw error;
      }
      if (!recorded) {
        await paneClose(paneId).catch((closeError: unknown) => console.warn("Could not close a sign-in tab whose login was not sent", closeError));
        return conflictResponse("login_in_progress", "A sign-in to this account is already open in a terminal tab. Finish or close it first.");
      }
      holding = opened;
      if (this.logins.get(home) === launch) this.logins.set(home, opened);
      // All variable argv are quoted by the bridge's existing POSIX shell encoder.
      if (process.platform === "win32") {
        const info = await paneProcessInfo(paneId);
        const shell = paneShell(info?.foreground_processes?.[0]?.argv?.[0] ?? "powershell.exe");
        const command = `${place ? credentialHomePrefix(shell, homeVariable, againHome) : ""}${shellCommandLine(shell, executable, args)}`;
        await paneSendText(paneId, `${command}${shell === "cmd" ? " & exit" : "; exit $LASTEXITCODE"}`);
        unusedCredentialHome = null;
        await paneSendKeys(paneId, ["Enter"]);
      } else {
        await paneSendText(paneId, `${manual ? "printf 'Type /login in Claude to sign in.\\n'; " : ""}exec ${place ? credentialHomePrefix("posix", homeVariable, againHome) : ""}${shellCommandLine("posix", executable, args)}\n`);
        unusedCredentialHome = null;
      }
      // the login runs: the home is its until it exits; a launch that failed before here frees it below
      reserved = null;
      return jsonResponse({
        pane_id: paneId, workspace_id: created.tab.workspace_id, manual, device_auth: device,
      } satisfies UsageLoginStarted);
    } catch (error) {
      return errorResponse(error);
    } finally {
      // made for a login that was never sent (failed, refused or cancelled): an Add account retry may name it again
      if (unusedCredentialHome) {
        try { rmdirSync(unusedCredentialHome); }
        catch (cleanupError) {
          // A CLI may already have written credentials; never remove a nonempty home.
          if (!(cleanupError instanceof Error && "code" in cleanupError
            && ["ENOTEMPTY", "EEXIST", "ENOENT"].includes(String(cleanupError.code)))) {
            console.warn("Could not remove unused sign-in credential home", cleanupError);
          }
        }
      }
      // refused, or failed before its login ran: the home is free again, unless its tab ended and another took it since
      if (reserved !== null && holding !== null) this.release(reserved, holding);
    }
  }
}

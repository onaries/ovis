# Ovis

Ovis, the browser and phone client for herdr.

<p align="center">
  <img src="public/icons/icon-192.png" alt="Ovis" width="100">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <a href="https://ovis.sh/">website</a> ·
  <a href="#install">install</a> ·
  <a href="https://ovis.sh/demo/">try the demo</a> ·
  <a href="docs/guide.md#quick-start">quick start</a> ·
  <a href="#faq">faq</a> ·
  <a href="#docs">docs</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-666666?labelColor=333333" alt="MIT license"></a>
  <a href="https://github.com/devswha/ovis/stargazers"><img src="https://img.shields.io/github/stars/devswha/ovis?labelColor=333333&color=666666&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/devswha/ovis/releases/latest"><img src="https://img.shields.io/github/v/release/devswha/ovis?label=release&labelColor=333333&color=666666" alt="Latest release"></a>
  <a href="https://github.com/herdrdev/herdr"><img src="https://img.shields.io/badge/herdr-0.9.0%2B-666666?labelColor=333333" alt="herdr 0.9.0+"></a>
  <a href="docs/guide.md#on-your-phone"><img src="https://img.shields.io/badge/PWA-installable-666666?labelColor=333333" alt="Installable PWA"></a>
</p>

**Claude Code and Codex, from your phone.** Read and reply to the agent sessions running on your computer as a chat, with the live terminal when you need it. Formerly herdr web UI.

---

https://github.com/user-attachments/assets/d854dbb6-64bd-4eba-81c7-fbd3f525726b

<p align="center"><sub>One Claude Code session: in herdr's terminal, then the browser's Terminal and Chat, then the phone, where a new worktree starts beside it · recorded live, no cuts</sub></p>

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/32ca9aa4-960f-4629-9fb5-17c12ba35c80"><img src="docs/media/readme/terminal.webp" width="100%" alt="Live recording. The browser shows Claude Code's reply in Chat; a click on Terminal shows the same pane as Claude Code's own terminal, with its edit adding the test &quot;unknown refund is 404&quot; to src/server.test.ts. On the phone, in the tests tab's terminal, ↑ on the key bar brings back bun test and the key bar's Enter runs it: 5 pass, 0 fail."></a>
      <br><b>Switch to the live terminal</b>
      <br><sub>One click turns the chat into the pane's real terminal; on the phone, ↑ on the key bar brings back the test command and Enter beside it runs it again.</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/22d10639-9aa6-4953-a5f3-a1b743f4053b"><img src="docs/media/readme/layout.webp" width="100%" alt="Live recording. The browser shows herdr's layout: four workspaces in the sidebar, each row ending in its agent's state (a green dot on checkout-api, whose Claude has finished, a turning arc on web-dashboard, whose Codex is working, nothing on infra and release), and checkout-api's tabs payments and dev. A click on the dev tab shows its first pane, tests, with bun test's 4 pass; the tab's pane menu lists the split's two panes, tests and git, and a click on git shows its git log while checkout-api's row names git. On the phone, ☰ opens the same four workspaces with the same states, and a tap on checkout-api opens Claude's chat: &quot;What does this repo do? Answer in one line.&quot; and its answer."></a>
      <br><b>Your herdr layout, in the browser</b>
      <br><sub>Every workspace, tab and split pane, with each agent's state: click a tab, pick a pane of a split, or switch workspaces from the phone.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/b228a2b8-6db5-4546-a15b-972056000cab"><img src="docs/media/readme/alerts.webp" width="100%" alt="Live recording. The phone shows another workspace's terminal while Claude works on checkout-api in the browser. When Claude asks which rate limit to use, an alert reading &quot;checkout-api Needs input&quot; drops in on the phone and a tap opens the question as a card; in the browser, checkout-api's row and its row under Agents show a red question mark, and the same card waits in its chat."></a>
      <br><b>Know when an agent needs you</b>
      <br><sub>On another workspace, an alert drops in when Claude asks; one tap opens its question.</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/a193b426-259c-47d9-bd73-10acc2594265"><img src="docs/media/readme/attach.webp" width="100%" alt="Live recording. On the phone, checkout-api's empty chat asks &quot;What should Claude do in checkout-api?&quot;. The + button attaches a screenshot of a receipt whose total reads $NaN and inserts its path, then &quot;Fix this, with a test.&quot; is typed and sent. The camera pulls back as the message with the screenshot appears on the phone and in the desktop's chat, then moves in on the desktop's chat. In the full video, Claude then runs its first command, which reads src/routes/receipt.ts and src/server.ts."></a>
      <br><b>Send a screenshot from your phone</b>
      <br><sub>The + button uploads it into the pane's folder and adds its path; Claude reads the image.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/bc419d3e-ebda-4fb5-acc5-e498609559fe"><img src="docs/media/readme/open.webp" width="100%" alt="Live recording. In the browser's terminal, Claude Code has written bench/p95.svg; a click on the path in its answer opens the chart in the file viewer, and a tap on the same path in the phone's chat opens it full screen."></a>
      <br><b>Open what the agent made</b>
      <br><sub>Click a path in the terminal, or tap it in the chat: the file opens right there.</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/150a4c9d-7667-4f63-ba56-8f91e6a25878"><img src="docs/media/readme/worktree.webp" width="100%" alt="Live recording. On the phone, checkout-api's ⋯ menu → New worktree opens a form with the branch worktree/clear-field-23e0 already filled in; Claude Code is picked and Create worktree is tapped. The camera moves to the browser, where checkout-api's folder is open with the new checkout nested under it, marked as Claude; its row then reads Claude Code over worktree-clear-field-23e0, and the Agents list shows it as a fourth agent."></a>
      <br><b>Branch off a second agent</b>
      <br><sub>From the phone, ⋯ → New worktree: the branch is filled in, pick an agent, and it starts beside the first.</sub>
    </td>
  </tr>
</table>

<p align="center"><sub>Each clip is a live recording of the desktop and a phone at once, in real time with no cuts. Click one for the full video.</sub></p>

- **Chat and terminal, one pane** — native Claude Code, Codex, omp, omo, gjc, pi, Hermes and explicitly identified Devin CLI transcripts, plus OpenCode sessions herdr identifies, Grok sessions on Linux and macOS, and experimental Antigravity (agy) support under the limits below, with the live terminal a click away. Queue a message while the agent works for the next turn, or send it at once with Send now. [Supported agents →](docs/guide.md#supported-agents)
- **Approve with a tap** — supported approvals, questions and plan menus become cards, checked to be current before your answer is sent. Use Terminal for requests without card support.
- **Know when you're needed** — live status for every pane, an alert that drops in while the app is open, and push alerts when an agent needs input or finishes, even with the app closed.
- **Install it on your phone** — a PWA with a key bar above the keyboard (Esc, Tab, Ctrl, Alt, Shift, Enter, arrows) that you can rearrange and extend with your own combinations in Settings, and a QR code to your Tailscale address. [Phone setup →](docs/guide.md#on-your-phone)
- **Speak instead of typing** — dictate into the chat or the terminal line, Korean and English mixed. Review the words before sending them to the agent; transcription uses your own OpenAI key or the browser's speech recognition.
- **Review repository changes** — open working-tree, staged or commit comparisons from the file browser and read each file's diff without changing the repository.
- **Keep your workflow** — herdr owns the agents; this app connects to them. Update from Settings without stopping them, with patch notes for what each update brings. New tabs and worktrees come from a row's ⋯ menu. [All features →](docs/guide.md#features)

---

## install

```bash
curl -fsSL https://ovis.sh/install.sh | sh
```

Linux with glibc (x64, arm64) or macOS (Intel, Apple Silicon); not Alpine/musl or 32-bit ARM. Have `curl`, Git and `tar` installed; installing a missing Bun also needs Bash and `unzip`. Requires herdr 0.9.0+ and Bun 1.4+; Node is not needed. The installer adds missing prerequisites for your user, upgrades an older Bun, then installs the app as a herdr plugin. Terminals run on the Rust PTY host each release ships, checked against its SHA-256; a Node 18+ already on the PC is only its fallback. If an existing herdr installation is older than 0.9.0, update and restart herdr yourself before rerunning the installer.

With the default listen address and Tailscale running, successful HTTPS setup provides a tailnet address and QR code. Without a configured token, your devices normally get in without a code when `tailscale serve` reports the same login as this PC's owner. If your own phone is asked to pair anyway, `OVIS_TAILSCALE_SERVE_ONLY=1` allows the no-login path only when Tailscale confirms one login owns the tailnet with no tagged nodes, and serve is the sole route to this port. Never enable it when a public proxy, tunnel or other forwarding server also reaches the port ([Access and safety](docs/guide.md#access-and-safety)).

Windows x64, in PowerShell:

```powershell
irm https://ovis.sh/install.ps1 | iex
```

Requires [Git for Windows](https://git-scm.com/download/win). Installs missing herdr and Bun for your user, then installs the same plugin. No Node or WSL is needed. Open **Phone setup** in herdr for phone access. Windows terminals use the [screen mirror](docs/remote-pcs.md#windows-pcs), with typing and a fixed grid, until herdr supports terminal attach there.

<p align="center">
  <img src="docs/screenshots/install.png" width="720" alt="Installer output: Bun and the herdr plugin install, then tailscale serve publishes the app and a QR code for the phone appears.">
</p>

Already have herdr 0.9.0+ and Bun 1.4+? Install just the plugin:

```bash
herdr plugin install devswha/ovis
```

An older herdr has to be updated and restarted first. [INSTALL.md](INSTALL.md) walks through each step and what to do when one fails.

With herdr running, use the address the installer prints or opens, normally **[127.0.0.1:7317](http://127.0.0.1:7317)**; the plugin can choose and remember another port if that one is busy. On a plugin-only install, run herdr's **Start Ovis** action. On a new install on a PC with a desktop, the installer opens the address in your browser for you; click **Install** in the address bar to add the app. The installed app belongs to that exact address, so keep using it rather than switching between `127.0.0.1` and `localhost`. Set `OVIS_NO_OPEN=1` before running the installer to skip opening the browser. Pick a pane or start an agent with **New workspace**. To use your phone, scan the installer's QR code (also available from herdr's **Phone setup**) and add the app to your home screen. [Quick start →](docs/guide.md#quick-start)

The server listens on `127.0.0.1` by default. For access from another device, see [phone setup](docs/guide.md#on-your-phone) and [access and safety](docs/guide.md#access-and-safety).

## faq

**Can I use Claude Code or Codex from my phone?**

Yes. Run the agent in a [herdr](https://github.com/herdrdev/herdr) pane on your computer, and this app shows the same pane in your phone's browser: the agent's own transcript as a chat, its approvals and questions as cards you tap, and the live terminal a tap away. It installs to the home screen as a PWA and sends a push alert when an agent needs you. [Phone setup →](docs/guide.md#on-your-phone)

**Which agents does the chat view support?**

Claude Code, Codex, omp, omo, gjc, pi and Hermes are read from their own session stores. GJC chat and done alerts use Ovis's native GJC extension to identify the active session, without an SDK broker or CLI lookup. [Install the extension](docs/guide.md#supported-agents) and restart GJC to enable them; missing or ambiguous session identity uses Terminal and herdr's own status. For OpenCode, chat reads the session herdr reports from its SQLite database, including supported 2.x and 1.x schemas. The home screen, missing session identity or an unsupported, unreadable or over-limit store uses the terminal instead. Devin CLI is a chat when herdr or the running process names its session, as `devin --resume <id>` does; a plain `devin` shows the live terminal.

Grok chat runs on Linux and macOS and requires one process-held session matching herdr's session identity; Windows or ambiguous identity use Terminal. Antigravity (agy) chat is experimental: Linux native-tested, macOS untested, Windows terminal-only. It follows the running process's held conversation lock rather than guessing a session. Any unsupported or unresolved transcript uses the terminal instead. [Supported agents →](docs/guide.md#supported-agents)

**Does it replace herdr's own TUI?**

No. Both attach to the same terminals at the same time, so the pane stays live at your desk, in the browser and on the phone. Nothing is stopped or handed over. [TUI and browser →](docs/guide.md#faq)

**Do I need Tailscale?**

No. Tailscale, an SSH tunnel, a VPN or your own HTTPS proxy can provide a route to the PC. The optional [Portal integration](docs/guide.md#behind-a-reverse-proxy) can manage a public HTTPS address after you install Portal 2.6.1+ separately; it requires `OVIS_TOKEN`, a trusted relay and `OVIS_TAILSCALE_SERVE_ONLY` off. Installation and push alerts need a secure context such as HTTPS or localhost; basic browsing also works over plain HTTP on a LAN. [The options →](docs/guide.md#faq)

**Does my code or conversation leave my machine?**

Session files stay on the PC running each agent, and their contents are served to browsers you connect. The app has no hosted relay or account service of its own. Optional voice input sends audio (and text when polishing) to the configured provider; browser speech recognition may also use the browser vendor's service. Enabled usage meters contact provider APIs. Updates, remote-PC setup and push alerts can also use external services. If you enable Portal, connections pass through your chosen relay, which sees connection metadata and holds the address's certificate; use a relay you trust.

Anonymous usage counts are on by default. After showing its notice and a ten-minute grace period, the app can send install/update counts with a random installation ID, version (and previous version on update), OS, CPU architecture, install method and an allowlisted settings snapshot. Custom text and account identities are omitted or summarized; code, conversations and files are not collected. The checked-in receiver adds a country code when Cloudflare provides one, but stores no IP address. Activity counts include the kinds of agents running on days the app is opened (UTC); the same day's count can be updated when a new kind appears. **Settings → About → Anonymous usage counts** shows the payload and turns sending off; `OVIS_TELEMETRY=0` or `DO_NOT_TRACK=1` also disables it. The agents’ own model connections depend on their configuration. [Data flow and access →](docs/guide.md#faq)

The random ID links counts from the same installation; it is not a guarantee of anonymity.

**Does it work on Windows?**

Yes, on Windows x64 without WSL. Until herdr can attach a terminal there, the terminal is a [screen mirror](docs/remote-pcs.md#windows-pcs) with typing and a fixed grid.

**How is it different from collie, roamgate or herdr-remote?**

These are other phone or browser clients for herdr. This one reads the agent's own transcript, so a pane is a chat with the work folded per turn rather than terminal output, and other PCs join over SSH from the sidebar. It includes repository diffs and can manage a separately installed Portal tunnel, but drives only herdr and bundles no tunnel. For tmux, zellij or Telegram, compare the other clients. [The full comparison →](docs/guide.md#faq)

**How is it different from Happy, Paseo or CloudCLI UI?**

Those projects provide their own ways to start or manage agent sessions. This app works with the herdr panes you already run, keeping the same terminals available in the TUI and browser. If you do not use herdr, compare those projects’ deployment options and agent support. [The full comparison →](docs/guide.md#faq)

## docs

Start with the [user guide](docs/guide.md): [quick start](docs/guide.md#quick-start) · [supported agents](docs/guide.md#supported-agents) · [features](docs/guide.md#features) · [phone](docs/guide.md#on-your-phone) · [remote PCs](docs/remote-pcs.md) · [access and safety](docs/guide.md#access-and-safety) · [configuration](docs/guide.md#configuration) · [keyboard shortcuts](docs/guide.md#keyboard-shortcuts) · [FAQ](docs/guide.md#faq).

For a closer look: [how it works](docs/guide.md#how-it-works) · [chat transcripts](docs/chat-mode-audit.md) · [terminal flow control](docs/terminal-flow-control.md) · [app updates](docs/app-updates.md) · [changelog](CHANGELOG.md).

## thanks

Built on [herdr](https://github.com/herdrdev/herdr), with inspiration from [chatmux](https://github.com/devswha/chatmux), and powered by [xterm.js](https://xtermjs.org), [React](https://react.dev), [Bun](https://bun.sh) and [Lucide](https://lucide.dev).

Thanks to everyone who has contributed, including [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha).

## agent instructions

Helping someone install the app? Follow [INSTALL.md](INSTALL.md). For repository changes, follow [CONTRIBUTING.md](CONTRIBUTING.md), the [review rules](.github/REVIEW.md) and [AGENTS.md](AGENTS.md).

## development

```bash
git clone https://github.com/devswha/ovis.git
cd ovis
bun install

bun run server      # API + WebSocket on :7317
bun run dev         # Vite on :5173; run in a second terminal
```

```bash
bun run typecheck
bun run test:unit   # no herdr needed
bun test           # isolated herdr test session
bun run test:ui    # browser regression checks
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to send a change, [development](docs/development.md) for tests, media and releases, and [DESIGN.md](DESIGN.md) for UI conventions. Report security problems privately: [SECURITY.md](SECURITY.md).

## license

[MIT](LICENSE). Copyright © 2026 devswha.

<p align="center">
  <img src="public/icons/icon-192.png" alt="Ovis" width="100">
</p>

<h1 align="center">Ovis</h1>

<p align="center">
  <strong>Every coding agent, on every screen.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-666666?labelColor=333333" alt="MIT license"></a>
  <a href="https://github.com/devswha/ovis/releases/latest"><img src="https://img.shields.io/github/v/release/devswha/ovis?label=release&labelColor=333333&color=666666" alt="Latest release"></a>
  <a href="https://github.com/devswha/ovis/stargazers"><img src="https://img.shields.io/github/stars/devswha/ovis?labelColor=333333&color=666666&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/herdrdev/herdr"><img src="https://img.shields.io/badge/herdr-0.9.0%2B-666666?labelColor=333333" alt="herdr 0.9.0+"></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
  <br>
  <a href="https://ovis.sh/">website</a> ·
  <a href="#install">install</a> ·
  <a href="https://ovis.sh/demo/">try the demo</a> ·
  <a href="docs/guide.md#quick-start">quick start</a> ·
  <a href="docs/guide.md#faq">faq</a> ·
  <a href="#docs">docs</a>
</p>

Ovis shows the coding agents on your computer as chats you answer with a click or a tap, in any browser, the Mac app or your phone. A client for [herdr](https://github.com/herdrdev/herdr), formerly herdr web UI.

<p align="center">
  <a href="https://ovis.sh/demo/"><img src="docs/media/readme/hero.webp" alt="Screen recording of Ovis on the demo: in a desktop browser, a follow-up is sent to Claude Code and its turn streams in step by step; then the desktop and a phone side by side, where Codex asks Allow command? for git push origin feat/export-guard, Yes is tapped on the phone and the card closes on both screens; then a click on the release tab opens a shell pane as a live terminal running git log and bun test."></a>
  <br>
  <sub>Recorded on the <a href="https://ovis.sh/demo/">demo</a>, which runs in your browser.</sub>
</p>

## install

**On your computer**

- **Mac:** download [Ovis.dmg](https://ovis.sh/Ovis.dmg), open it and click **Install**.
- **Windows:** download [Ovis.exe](https://ovis.sh/Ovis.exe), run it and click **Install**.
- **Linux:** run this in a terminal.
  ```bash
  curl -fsSL https://ovis.sh/install.sh | sh
  ```

Each one adds herdr and Bun if they are missing; Node is not needed. Other ways to install, step by step: [INSTALL.md](INSTALL.md).

**On your phone**

- **iPhone:** the TestFlight beta, from [ovis.sh/beta](https://ovis.sh/beta/).
- **Android:** the Google Play beta, from [ovis.sh/beta](https://ovis.sh/beta/).
- **Browser:** no app needed; add the page to the home screen.

With Tailscale on in both, scan the QR code your computer shows to connect.

## what you get

- **Any agent herdr runs.** Claude Code, Codex, OpenCode, pi, omp, Gajae Code, Hermes, Grok and more, most as a chat. [Supported agents →](docs/guide.md#supported-agents)
- **Prompts as cards.** Checked as still current before your answer is sent.
- **The live terminal, one click away.** The same pane herdr shows, with a key bar on phones.
- **Every workspace in one list.** Tabs, splits and other PCs over SSH, with the ones waiting on you marked.
- **Push alerts.** When an agent asks something or finishes, even with the app closed.
- **Free and MIT.** Runs on your own computer, with no account to sign up for.

[All features →](docs/guide.md#features)

**Limits:** Ovis needs [herdr](https://github.com/herdrdev/herdr) and your own computer, switched on, and your phone has to reach it (Tailscale, a VPN or an SSH tunnel).

**Privacy:** sessions stay on the computer that runs each agent, and Ovis has no account or hosted relay of its own. Anonymous usage counts are on by default; **Settings → About → Anonymous usage counts** shows what is sent and turns them off, as does `OVIS_TELEMETRY=0`. [What is sent →](docs/guide.md#anonymous-usage-counts)

## docs

- **[User guide](docs/guide.md):** [quick start](docs/guide.md#quick-start) · [supported agents](docs/guide.md#supported-agents) · [features](docs/guide.md#features) · [phone](docs/guide.md#on-your-phone) · [remote PCs](docs/remote-pcs.md) · [access and safety](docs/guide.md#access-and-safety) · [configuration](docs/guide.md#configuration) · [keyboard shortcuts](docs/guide.md#keyboard-shortcuts)
- **[FAQ](docs/guide.md#faq):** herdr's own TUI, Tailscale, what leaves your machine, and how Ovis compares with collie, Happy, Paseo and others.
- **[INSTALL.md](INSTALL.md):** every way to install, step by step, and what to do when a step fails.
- **[Demo](https://ovis.sh/demo/):** the real app on a made-up session, in your browser.
- **[Changelog](CHANGELOG.md)**

## thanks

Built on [herdr](https://github.com/herdrdev/herdr), with inspiration from [chatmux](https://github.com/devswha/chatmux), and powered by [xterm.js](https://xtermjs.org), [React](https://react.dev), [Bun](https://bun.sh) and [Lucide](https://lucide.dev).

Thanks to everyone who has contributed, including [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha), and to [@sanguneo](https://github.com/sanguneo), who helped design the icon and the website.

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

See [CONTRIBUTING.md](CONTRIBUTING.md) to send a change, [development](docs/development.md) for tests, media and releases, and [DESIGN.md](DESIGN.md) for UI conventions. Report security problems privately: [SECURITY.md](SECURITY.md).

## license

[MIT](LICENSE). Copyright © 2026 devswha.

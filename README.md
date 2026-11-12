<p align="center">
  <img src="public/icons/icon-192.png" alt="Ovis" width="100">
</p>

<h1 align="center">Ovis</h1>

<p align="center">
  <strong>Your coding agents, on desktop, phone and browser.</strong>
  <br>
  Chat with Claude Code, Codex and other agents running on your computer, and answer them with a tap.
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
  <a href="https://ovis.sh/demo/">demo</a> ·
  <a href="docs/guide.md">docs</a> ·
  <a href="https://ovis.sh/discord">discord</a>
</p>

<p align="center">
  <a href="https://ovis.sh/demo/"><img src="docs/media/readme/desktop-and-phone.webp" width="830" alt="Ovis in a desktop browser and on a phone. The desktop shows a sidebar of workspaces and agents beside a Claude Code conversation read as a chat. The phone shows a Codex pane asking Allow command? for git push origin feat/export-guard, with Yes, Yes and don't ask again for git push, and No as the choices."></a>
</p>

Ovis runs on the computer where your agents work, and your phone or any browser connects to it. It is built on [herdr](https://github.com/herdrdev/herdr) and shows the same live terminals as herdr and the [Herdr app](https://herdr.dev/download/), so they work side by side. [How they fit together →](docs/guide.md#how-ovis-fits-with-herdr)

## Install

**Desktop app:** [Mac](https://ovis.sh/Ovis-mac-arm64.dmg) ([Intel](https://ovis.sh/Ovis-mac-x64.dmg)) · [Windows](https://ovis.sh/Ovis-win-x64.exe) · [Linux](https://ovis.sh/Ovis-linux-x64.deb) ([all builds](docs/guide.md#the-desktop-app)). It needs nothing else.

**With herdr or the Herdr app:** one command sets Ovis up beside it. On Linux or macOS:

```bash
curl -fsSL https://ovis.sh/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://ovis.sh/install.ps1 | iex
```

**On your phone:** on the computer, open **Settings → Devices and PCs → Add a connection → Ovis relay**, switch it on and scan the QR code it shows. A computer in an Ovis account asks the phone to sign in instead. The [iPhone and Android apps](https://ovis.sh/beta/) are in beta. [Phone setup →](docs/guide.md#on-your-phone)

## Features

- **Agents as a chat.** Claude Code, Codex and [more](docs/guide.md#supported-agents), with a turn's commands and edits folded into one line.
- **Answers with a tap.** Approvals and questions arrive as cards.
- **Push alerts.** Even with the app closed.
- **The real terminal, one click away.** With a key bar on phones.
- **New agents from anywhere.** In a folder you pick, from the desktop or the phone.
- **Every workspace in one list.** Other PCs over SSH too.

[All features →](docs/guide.md#features)

<details>
<summary>Watch it in motion (a 25-second clip)</summary>
<p align="center">
  <a href="https://ovis.sh/demo/"><img src="docs/media/readme/hero.webp" alt="Screen recording of Ovis on the demo: in a desktop browser, a follow-up is sent to Claude Code and its turn streams in step by step; then the desktop and a phone side by side, where Codex asks Allow command? for git push origin feat/export-guard, Yes is tapped on the phone and the card closes on both screens; then a click on the release tab opens a shell pane as a live terminal running git log and bun test."></a>
  <br>
  <sub>Recorded on the <a href="https://ovis.sh/demo/">demo</a>, which runs in your browser.</sub>
</p>
</details>

**Limits:** your computer has to be on and reachable (the Ovis relay, Tailscale, a VPN or an SSH tunnel). Chat is complete for Claude Code and thinner for other agents; the real terminal always works. On Windows, the one-line install starts on herdr until you switch to the Herdr app's terminals in **Settings → About → Terminals**.

**Privacy:** sessions stay on your computer, and no account is needed. The relay is end-to-end encrypted ([trust model](docs/relay.md#trust-model)). Anonymous usage counts are on by default; **Settings → About** or `OVIS_TELEMETRY=0` turns them off ([what is sent](docs/guide.md#anonymous-usage-counts)).

## Documentation

- **[User guide](docs/guide.md):** [quick start](docs/guide.md#quick-start) · [supported agents](docs/guide.md#supported-agents) · [phone](docs/guide.md#on-your-phone) · [remote PCs](docs/remote-pcs.md) · [configuration](docs/guide.md#configuration) · [FAQ](docs/guide.md#faq)
- **[INSTALL.md](INSTALL.md):** every way to install, step by step.
- **[Demo](https://ovis.sh/demo/)** · **[Changelog](CHANGELOG.md)**

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) has the setup and the checks, with [development](docs/development.md), [DESIGN.md](DESIGN.md) and [SECURITY.md](SECURITY.md). Coding agents install Ovis for someone with [INSTALL.md](INSTALL.md), and follow [AGENTS.md](AGENTS.md) and the [review rules](.github/REVIEW.md) for changes.

## Thanks

Built on [herdr](https://github.com/herdrdev/herdr), with inspiration from [chatmux](https://github.com/devswha/chatmux), and powered by [xterm.js](https://xtermjs.org), [React](https://react.dev), [Bun](https://bun.sh) and [Lucide](https://lucide.dev). Thanks to everyone who has contributed, including [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha), and to [@sanguneo](https://github.com/sanguneo), who helped design the icon and the website.

## License

[MIT](LICENSE). Copyright © 2026 devswha.

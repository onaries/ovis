# Ovis

Ovis，herdr 的浏览器和手机客户端。

<p align="center">
  <img src="public/icons/icon-192.png" alt="Ovis" width="100">
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <a href="https://ovis.sh/">官网</a> ·
  <a href="#install">安装</a> ·
  <a href="https://ovis.sh/demo/">体验演示</a> ·
  <a href="docs/guide.md#quick-start">快速入门</a> ·
  <a href="#faq">常见问题</a> ·
  <a href="#docs">文档</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-666666?labelColor=333333" alt="MIT 许可证"></a>
  <a href="https://github.com/devswha/ovis/stargazers"><img src="https://img.shields.io/github/stars/devswha/ovis?labelColor=333333&color=666666&logo=github" alt="GitHub 星标数"></a>
  <a href="https://github.com/devswha/ovis/releases/latest"><img src="https://img.shields.io/github/v/release/devswha/ovis?label=release&labelColor=333333&color=666666" alt="最新版本"></a>
  <a href="https://github.com/herdrdev/herdr"><img src="https://img.shields.io/badge/herdr-0.9.0%2B-666666?labelColor=333333" alt="herdr 0.9.0+"></a>
  <a href="docs/guide.md#on-your-phone"><img src="https://img.shields.io/badge/PWA-installable-666666?labelColor=333333" alt="可安装的 PWA"></a>
</p>

**在手机上使用 Claude Code 和 Codex。** 以聊天方式阅读并回复你电脑上正在运行的智能体会话，需要时可切换到真正的终端。原名 herdr web UI。

---

https://github.com/user-attachments/assets/d854dbb6-64bd-4eba-81c7-fbd3f525726b

<p align="center"><sub>同一个 Claude Code 会话：从 herdr 终端到浏览器的终端和聊天，再到手机，在手机上紧挨着它启动一个新的 worktree · 实机录制，无剪辑</sub></p>

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/32ca9aa4-960f-4629-9fb5-17c12ba35c80"><img src="docs/media/readme/terminal.webp" width="100%" alt="实机录制。浏览器的 Chat 中是 Claude Code 的回复；点击 Terminal，同一窗格显示为 Claude Code 自己的终端，可以看到它在 src/server.test.ts 中添加测试“unknown refund is 404”的修改。在手机上，在 tests 标签页的终端里，按键栏的 ↑ 调出 bun test，按键栏的 Enter 运行它：5 pass，0 fail。"></a>
      <br><b>切换到实时终端</b>
      <br><sub>点一下，聊天就变成该窗格真正的终端；在手机上，按键栏的 ↑ 调出测试命令，再按旁边的 Enter 重新运行。</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/22d10639-9aa6-4953-a5f3-a1b743f4053b"><img src="docs/media/readme/layout.webp" width="100%" alt="实机录制。浏览器显示 herdr 的布局：侧边栏中的四个工作区，每行末尾显示其智能体的状态（Claude 已完成的 checkout-api 是绿点，Codex 正在工作的 web-dashboard 是转动的弧，infra 和 release 没有标记），checkout-api 有 payments 和 dev 两个标签页。点击 dev 标签页，显示它的第一个窗格 tests，其中 bun test 为 4 pass；标签页的窗格菜单列出分屏的两个窗格 tests 和 git，点击 git 显示其 git log，同时 checkout-api 那一行显示 git。在手机上，☰ 打开同样状态的同样四个工作区，轻点 checkout-api 打开 Claude 的聊天：“What does this repo do? Answer in one line.”及其回答。"></a>
      <br><b>浏览器里的 herdr 布局</b>
      <br><sub>工作区、标签页、分屏窗格，以及每个智能体的状态都在：点一下标签页，选择分屏中的窗格，在手机上切换工作区。</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/b228a2b8-6db5-4546-a15b-972056000cab"><img src="docs/media/readme/alerts.webp" width="100%" alt="实机录制。浏览器中 Claude 在处理 checkout-api 时，手机显示的是另一个工作区的终端。Claude 询问要用哪种速率限制时，手机上弹出“checkout-api Needs input”提醒，轻点后问题以卡片形式打开；浏览器中，checkout-api 那一行和 Agents 下它的那一行都显示红色问号，同一张卡片在聊天中等待。"></a>
      <br><b>智能体需要你时，立刻知道</b>
      <br><sub>即使在看别的工作区，Claude 一提问就会弹出提醒，点一下即可打开它的问题。</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/a193b426-259c-47d9-bd73-10acc2594265"><img src="docs/media/readme/attach.webp" width="100%" alt="实机录制。手机上，checkout-api 的空聊天问道“What should Claude do in checkout-api?”。用 + 按钮附上一张合计显示为 $NaN 的收据截图并插入其路径，然后输入“Fix this, with a test.”并发送。带截图的消息出现在手机和电脑的聊天中时，镜头拉远，再推近电脑的聊天。完整视频中，Claude 随后运行第一条命令，读取 src/routes/receipt.ts 和 src/server.ts。"></a>
      <br><b>从手机发送截图</b>
      <br><sub>+ 按钮把它上传到窗格的文件夹并插入路径，Claude 会读取这张图。</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/bc419d3e-ebda-4fb5-acc5-e498609559fe"><img src="docs/media/readme/open.webp" width="100%" alt="实机录制。在浏览器的终端中，Claude Code 写出了 bench/p95.svg；点击它回答中的路径，图表在文件查看器中打开；在手机聊天中轻点同一路径，则全屏打开。"></a>
      <br><b>打开智能体生成的文件</b>
      <br><sub>在终端里点击路径，或在聊天里轻点路径，文件就地打开。</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/150a4c9d-7667-4f63-ba56-8f91e6a25878"><img src="docs/media/readme/worktree.webp" width="100%" alt="实机录制。在手机上打开 checkout-api 的 ⋯ 菜单 → New worktree，表单中分支 worktree/clear-field-23e0 已自动填好；选择 Claude Code 并轻点 Create worktree。镜头移到浏览器，checkout-api 的文件夹已展开，新的检出以 Claude 标记嵌套在其下；随后这一行显示为 worktree-clear-field-23e0 上方的 Claude Code，Agents 列表中也多了第四个智能体。"></a>
      <br><b>分出第二个智能体</b>
      <br><sub>在手机上点 ⋯ → New worktree：分支已自动填好，选一个智能体，它就在第一个旁边启动。</sub>
    </td>
  </tr>
</table>

<p align="center"><sub>每段片段都是同时录制电脑和手机的真实操作，实时、无剪辑。点击可播放完整视频。</sub></p>

- **聊天与终端，共用一个窗格** — 阅读 Claude Code、Codex、omp、omo、gjc、pi、Hermes 的原生会话记录，以及可明确识别的 OpenCode 和 Devin CLI 会话。Linux 和 macOS 上的 Grok 和实验性的 Antigravity（agy）也按下文所述条件提供支持，一键即可切换到同一窗格的终端。智能体工作时可将消息排队到下一轮发送，也可以用 Send now 立即发送。[支持的智能体 →](docs/guide.md#supported-agents)
- **轻点即可批准** — 支持的审批请求、问题和计划菜单会显示为卡片，发送回答前会先确认提示仍然有效。不支持卡片的请求需在终端中回答。
- **需要你时及时提醒** — 实时显示每个窗格的状态；应用打开时提醒会从顶部滑下；智能体需要输入或完成任务时发送推送通知，即使应用已关闭也能收到。
- **安装到手机** — PWA 在键盘上方提供按键栏（Esc、Tab、Ctrl、Alt、Shift、Enter 和方向键），可在 Settings（设置）中调整顺序或添加自定义组合键；Tailscale 地址以二维码显示。[手机设置 →](docs/guide.md#on-your-phone)
- **开口代替打字** — 在聊天或终端输入行中语音输入，可选择中文等识别语言，并识别混在其中的英语代码术语；文字只放进输入框，不会自动发送给智能体。使用你自己的 OpenAI API 密钥，或浏览器的语音识别。录音等对外传输的详情见[语音输入](docs/guide.md#voice-input)。
- **查看仓库改动** — 从文件浏览器打开工作区、暂存区或提交之间的比较，逐个阅读文件差异，不会修改仓库。
- **沿用现有工作流** — 智能体由 herdr 管理，本应用负责连接；在 Settings（设置）中更新应用，无需停止智能体，每次更新带来的变化以更新说明列出。新标签页和 worktree 可从行的 ⋯ 菜单创建。[全部功能 →](docs/guide.md#features)

---

<a id="install"></a>

## 安装

```bash
curl -fsSL https://ovis.sh/install.sh | sh
```

支持基于 glibc 的 Linux（x64、arm64）和 macOS（Intel、Apple Silicon）；不支持 Alpine/musl 或 32 位 ARM。需预先安装 `curl`、Git 和 `tar`；如果没有 Bun，还需要 Bash 和 `unzip`。所需版本为 herdr 0.9.0+ 和 Bun 1.4+，无需 Node。安装程序为当前用户安装缺少的工具、升级旧版 Bun，然后将应用安装为 herdr 插件。终端运行在每个版本随附的 Rust PTY 主机上，安装时按 SHA-256 校验；电脑上已有的 Node 18+ 仅作后备。如果已安装的 herdr 低于 0.9.0，请先自行更新并重启 herdr，再重新运行安装程序。

使用默认监听地址且 Tailscale 正在运行时，HTTPS 配置成功后会提供 tailnet 内的地址和二维码。未配置访问令牌时，如果 `tailscale serve` 报告的登录名与这台电脑的所有者相同，你自己的设备通常无需验证码即可进入。如果自己的手机仍被要求配对，`OVIS_TAILSCALE_SERVE_ONLY=1` 只会在 Tailscale 确认整个 tailnet 由一个登录名拥有、没有带标签的节点，且 serve 是此端口唯一访问途径时，允许没有登录信息的连接。公共代理、隧道或其他转发服务也能访问该端口时，切勿启用此设置（[访问与安全](docs/guide.md#access-and-safety)）。

Windows x64 请在 PowerShell 中运行：

```powershell
irm https://ovis.sh/install.ps1 | iex
```

需要 [Git for Windows](https://git-scm.com/download/win)。安装程序会为当前用户补齐 herdr 和 Bun，然后安装同一个插件，无需 Node 或 WSL。要在手机上使用，请在 herdr 中打开 **Phone setup**。在 herdr 支持 Windows 终端附加之前，Windows 上的终端是一个可以输入、网格固定的[屏幕镜像](docs/remote-pcs.md#windows-pcs)。

<p align="center">
  <img src="docs/screenshots/install.png" width="720" alt="安装程序输出：安装 Bun 和 herdr 插件，然后通过 tailscale serve 提供应用访问地址，并显示供手机扫描的二维码。">
</p>

已安装 herdr 0.9.0+ 和 Bun 1.4+？只需安装插件：

```bash
herdr plugin install devswha/ovis
```

旧版 herdr 必须先更新并重启。[INSTALL.md](INSTALL.md) 说明了各步操作及失败时的处理方法。

在 herdr 运行时，使用安装程序打印或打开的地址，通常是 **[127.0.0.1:7317](http://127.0.0.1:7317)**；默认端口被占用时，插件会选择并记住其他端口。如果只安装了插件，请在 herdr 中运行 **Start Ovis**。首次安装到有桌面环境的电脑时，安装程序会自动打开浏览器；点击地址栏中的 **Install（安装）** 即可添加应用。安装后的应用属于这个确切地址，请继续使用同一地址，不要在 `127.0.0.1` 和 `localhost` 之间切换。安装前设置 `OVIS_NO_OPEN=1` 可跳过自动打开浏览器。选择一个窗格，或点击 **New workspace（新建工作区）** 启动智能体。在手机上使用时，扫描安装程序的二维码（也可从 herdr 的 **Phone setup** 查看），并将应用添加到主屏幕。[快速入门 →](docs/guide.md#quick-start)

服务器默认监听 `127.0.0.1`。如需从其他设备访问，请参阅[手机设置](docs/guide.md#on-your-phone)和[访问与安全](docs/guide.md#access-and-safety)。

<a id="faq"></a>

## 常见问题

**可以在手机上使用 Claude Code 或 Codex 吗？**

可以。在电脑上的 [herdr](https://github.com/herdrdev/herdr) 窗格里运行智能体，本应用就会在手机浏览器中显示同一个窗格：智能体自己的会话记录显示为聊天，审批和提问显示为可点按回答的卡片，随时可以切换到实时终端。它可以作为 PWA 安装到主屏幕，并在智能体需要你时发送推送提醒。[手机设置 →](docs/guide.md#on-your-phone)

**聊天视图支持哪些智能体？**

Claude Code、Codex、omp、omo、gjc、pi 和 Hermes 从各自的会话存储读取记录。GJC 聊天和完成提醒通过 Web UI 的原生 GJC 扩展识别当前会话，不依赖 SDK broker 或 CLI 查询。[安装该扩展](docs/guide.md#supported-agents)并重启 GJC 即可启用；无法明确识别会话时显示终端，并使用 herdr 自身的状态。OpenCode 从支持的 2.x 和 1.x SQLite 表结构中读取 herdr 报告的会话；开始界面、缺少会话 ID，以及不支持、无法读取或超出大小限制的存储则显示终端。Devin CLI 在 herdr 或运行中的进程明确指出其会话时（例如 `devin --resume <id>`）显示为聊天，直接运行 `devin` 则显示终端。

Grok 聊天支持 Linux 和 macOS，并要求进程只持有一个会话，且与 herdr 报告的会话一致；Windows 或身份不明确时显示终端。Antigravity（agy）是实验性支持，通过运行中进程持有的会话锁定位记录，而非猜测会话。Linux 已通过原生环境验证，macOS 尚未验证，Windows 仅显示终端。对于不支持或无法读取的记录，也会显示终端。[支持的智能体 →](docs/guide.md#supported-agents)

**它会取代 herdr 自带的 TUI 吗？**

不会。两者同时连接到同一批终端，所以窗格在桌面、浏览器和手机上都保持实时。不需要停止或交接任何东西。 [TUI 与浏览器 →](docs/guide.md#faq)

**必须使用 Tailscale 吗？**

不必。Tailscale、SSH 隧道、VPN 或自行配置的 HTTPS 代理都可以提供访问电脑的通路。单独安装 Portal 2.6.1+ 后，还可通过可选的 [Portal 集成](docs/guide.md#behind-a-reverse-proxy)管理公网 HTTPS 地址；它需要 `OVIS_TOKEN`、可信中继，并关闭 `OVIS_TAILSCALE_SERVE_ONLY`。安装应用和推送提醒需要 HTTPS 或 localhost 等安全上下文；基本浏览也可以使用局域网中的普通 HTTP 地址。[其他方式 →](docs/guide.md#faq)

**我的代码或对话会离开我的电脑吗？**

会话文件保留在运行各个智能体的电脑上，内容会发送到你连接的浏览器。本应用没有自有的云端中继或账号服务。可选的语音输入会将录音（启用文字整理时还包括文本）发送给配置的服务商；浏览器语音识别也可能使用浏览器厂商的服务。启用用量显示后会连接服务商 API；更新、远程电脑设置和推送提醒也可能使用外部服务。启用 Portal 后，连接会经过你选择的中继，它能看到连接元数据并持有该地址的证书，因此请只使用可信中继。

匿名使用计数默认启用。在应用内显示说明并留出 10 分钟等待时间后，应用可发送安装或更新计数，包含随机安装 ID、版本（更新时包括旧版本）、操作系统、CPU 架构、安装方式和白名单内的设置快照。自定义文本和账号标识会被省略或概括，不收集代码、对话或文件。仓库中的接收端会在 Cloudflare 提供国家/地区代码时记录该代码，但不保存 IP 地址。活动计数包含打开应用当天（UTC）的智能体类型；同一天出现新类型时可更新当日计数。可在 **Settings → About → Anonymous usage counts** 中查看内容并关闭，也可设置 `OVIS_TELEMETRY=0` 或 `DO_NOT_TRACK=1`。智能体自身如何连接模型，取决于它的配置。[数据传输与访问 →](docs/guide.md#faq)

随机 ID 可关联同一安装的计数，并不保证完全匿名。

**支持 Windows 吗？**

支持，在 Windows x64 上无需 WSL。在 herdr 支持 Windows 终端附加之前，终端是一个可以输入、网格固定的[屏幕镜像](docs/remote-pcs.md#windows-pcs)。

**它与 collie、roamgate、herdr-remote 有什么不同？**

这些项目也提供 herdr 的手机或浏览器客户端。本应用直接读取智能体自己的会话记录，将每轮工作过程折叠为聊天；其他电脑可从侧边栏通过 SSH 加入。它提供仓库差异查看，也能管理单独安装的 Portal 隧道，但只连接 herdr，不捆绑隧道程序。需要 tmux、zellij 或 Telegram 时，可比较其他客户端的支持范围。[完整对比 →](docs/guide.md#faq)

**它与 Happy、Paseo、CloudCLI UI 有什么不同？**

这些项目有各自启动或管理智能体会话的方式。本应用使用你已经运行的 herdr 窗格，让 TUI 和浏览器继续访问同一个终端。如果你不使用 herdr，可以比较这些项目的部署方式和智能体支持情况。[完整对比 →](docs/guide.md#faq)

<a id="docs"></a>

## 文档

从[用户指南](docs/guide.md)开始：[快速入门](docs/guide.md#quick-start) · [支持的智能体](docs/guide.md#supported-agents) · [功能](docs/guide.md#features) · [手机](docs/guide.md#on-your-phone) · [远程电脑](docs/remote-pcs.md) · [访问与安全](docs/guide.md#access-and-safety) · [配置](docs/guide.md#configuration) · [键盘快捷键](docs/guide.md#keyboard-shortcuts) · [常见问题](docs/guide.md#faq)。

深入了解：[工作原理](docs/guide.md#how-it-works) · [聊天记录](docs/chat-mode-audit.md) · [终端流量控制](docs/terminal-flow-control.md) · [应用更新](docs/app-updates.md) · [更新日志](CHANGELOG.md)。

## 致谢

本项目基于 [herdr](https://github.com/herdrdev/herdr) 构建，灵感来自 [chatmux](https://github.com/devswha/chatmux)，并使用了 [xterm.js](https://xtermjs.org)、[React](https://react.dev)、[Bun](https://bun.sh) 和 [Lucide](https://lucide.dev)。

感谢所有贡献者，包括 [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha)。

## 智能体操作指南

正在协助他人安装应用？请遵循 [INSTALL.md](INSTALL.md)。修改仓库时，请遵循 [CONTRIBUTING.md](CONTRIBUTING.md)、[审查规则](.github/REVIEW.md)和 [AGENTS.md](AGENTS.md)。

## 开发

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

提交改动请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)，测试、媒体素材和发布流程请参阅[开发文档](docs/development.md)，界面规范请参阅 [DESIGN.md](DESIGN.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

[MIT](LICENSE)。Copyright © 2026 devswha.

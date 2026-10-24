using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace Ovis
{
    internal enum Phase
    {
        Checking,
        NotInstalled,
        Working,
        Failed,
        Installed,
    }

    internal sealed class Status
    {
        public bool Running;
        public string Origin;
        /// <summary>The HTTPS address Tailscale serves the app at, which the phone opens.</summary>
        public string PhoneUrl;
        /// <summary>"missing", "stopped" or "running", as /api/access reports Tailscale.</summary>
        public string Tailscale;
    }

    internal sealed class Plugin
    {
        public string Id;
        public string Root;
    }

    /// <summary>
    /// Everything goes through what a terminal user runs (install.ps1, herdr, the plugin's scripts), so the
    /// app and the terminal never drift apart. The methods run on the window's thread.
    /// </summary>
    internal sealed class Model
    {
        private readonly SynchronizationContext context = SynchronizationContext.Current ?? throw new InvalidOperationException("Model is made on the window's thread, after the form's constructor started.");
        private readonly List<string> log = new List<string>();
        private Plugin plugin;

        public Phase Phase { get; private set; }
        public string Title { get; private set; }
        public Status Status { get; private set; }
        public bool GitMissing { get; private set; }
        public bool CanUseWinget { get; private set; }

        /// <summary>The action that failed, for Try again.</summary>
        public Func<Task> Retry { get; private set; }

        public event Action Changed;
        public event Action<string> LineAdded;

        public string LogText
        {
            get { lock (log) return string.Join(Environment.NewLine, log); }
        }

        public async Task Refresh()
        {
            Paths.RefreshPath();
            GitMissing = Paths.Which("git") == null;
            CanUseWinget = Paths.Which("winget") != null;
            plugin = Paths.Which("herdr") == null ? null : await FindPlugin();
            if (plugin == null)
            {
                Status = null;
                Set(Phase.NotInstalled);
                return;
            }
            Status = await ReadStatus(plugin);
            Set(Phase.Installed);
        }

        public async Task Install()
        {
            Retry = Install;
            ClearLog();
            Paths.RefreshPath();
            if (Paths.Which("git") == null)
            {
                await Refresh();
                return;
            }
            Set(Phase.Working, Lang.L("Installing herdr, Bun and the Ovis server…", "herdr, Bun, Ovis 서버를 설치하는 중…"));
            Environment.SetEnvironmentVariable("OVIS_NO_OPEN", "1");
            var result = await Run.Program("powershell", PowerShell(Links.InstallCommand), Append, true, 45 * 60);
            if (result.Status != 0)
            {
                Fail(Lang.L("The installer stopped with an error.", "설치 중 오류가 났습니다."));
                return;
            }
            Paths.RefreshPath();
            Set(Phase.Working, Lang.L("Starting herdr…", "herdr를 시작하는 중…"));
            try
            {
                LoginItem.Install();
            }
            catch (Exception exception)
            {
                Fail(Lang.L("Could not set herdr to start at login.", "로그인할 때 herdr가 켜지도록 설정하지 못했습니다."), exception.Message);
                return;
            }
            if (!await HerdrRunning()) Run.Detached("herdr", new[] { "server" });
            await WaitUntilRunning();
            await Refresh();
        }

        /// <summary>Git for Windows, which install.ps1 needs, from winget (Windows asks for administrator approval).</summary>
        public async Task InstallGit()
        {
            Retry = InstallGit;
            ClearLog();
            Set(Phase.Working, Lang.L("Installing Git for Windows…", "Git for Windows를 설치하는 중…"));
            var result = await Run.Program("winget", new[] { "install", "--id", "Git.Git", "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements" }, Append, true, 30 * 60);
            Paths.RefreshPath();
            if (Paths.Which("git") == null)
            {
                Fail(result.Status == 0
                    ? Lang.L("Git is installed, but this PC does not find it yet. Sign out and in again, then open Ovis again.", "Git을 설치했지만 아직 찾지 못했습니다. 로그아웃 후 다시 로그인한 뒤 Ovis를 다시 열어 주세요.")
                    : Lang.L("Git for Windows did not install.", "Git for Windows를 설치하지 못했습니다."));
                return;
            }
            await Install();
        }

        public async Task Restart()
        {
            Retry = Restart;
            ClearLog();
            Set(Phase.Working, Lang.L("Restarting…", "다시 시작하는 중…"));
            if (plugin != null && await HerdrRunning())
            {
                // the start waits until the old server has exited: started before, it would find that one
                // answering and leave nothing running once it goes
                if (!await Stop(plugin))
                {
                    Fail(Lang.L("Could not stop the Ovis server.", "Ovis 서버를 멈추지 못했습니다."));
                    return;
                }
                if ((await Run.Program("herdr", new[] { "plugin", "action", "invoke", plugin.Id + ".start-windows" }, Append)).Status != 0)
                {
                    Fail(Lang.L("Could not start the Ovis server.", "Ovis 서버를 시작하지 못했습니다."));
                    return;
                }
            }
            else
            {
                // herdr set up from a terminal has no login start yet: add it, as Install does
                try
                {
                    if (!LoginItem.Installed) LoginItem.Install();
                }
                catch (Exception exception)
                {
                    Fail(Lang.L("Could not set herdr to start at login.", "로그인할 때 herdr가 켜지도록 설정하지 못했습니다."), exception.Message);
                    return;
                }
                Run.Detached("herdr", new[] { "server" });
            }
            await WaitUntilRunning();
            await Refresh();
        }

        /// <summary>The installer's phone step: `tailscale serve` for this app, when Tailscale runs here.</summary>
        public async Task MakePhoneAddress()
        {
            if (plugin == null) return;
            Retry = MakePhoneAddress;
            ClearLog();
            Set(Phase.Working, Lang.L("Making the phone address…", "휴대폰 주소를 만드는 중…"));
            await Run.Program("bun", new[] { PluginScript(plugin), "phone" }, Append, true, 5 * 60);
            await Refresh();
        }

        /// <summary>
        /// Takes the Ovis server off this PC, as the guide's Uninstall does. herdr and Bun stay, and herdr keeps
        /// running: stopping it would end every agent in it.
        /// </summary>
        public async Task Remove()
        {
            Retry = Remove;
            ClearLog();
            Set(Phase.Working, Lang.L("Removing…", "제거하는 중…"));
            var phoneUrl = Status == null ? null : Status.PhoneUrl;
            if (plugin != null)
            {
                // removed with its server up, the checkout would go on serving from a deleted folder; the server
                // can outlive a herdr that crashed, so it is stopped whether herdr runs or not
                if (!await Stop(plugin))
                {
                    Fail(Lang.L("Could not stop the Ovis server, so nothing was removed.", "Ovis 서버를 멈추지 못해 아무것도 제거하지 않았습니다."));
                    return;
                }
                if ((await Run.Program("herdr", new[] { "plugin", "uninstall", plugin.Id }, Append, true, 5 * 60)).Status != 0)
                {
                    Fail(Lang.L("herdr could not remove the Ovis server.", "herdr가 Ovis 서버를 제거하지 못했습니다."));
                    return;
                }
            }
            var tailscale = Paths.Tailscale;
            Uri url;
            if (phoneUrl != null && tailscale != null && Uri.TryCreate(phoneUrl, UriKind.Absolute, out url))
            {
                await Run.Program(tailscale, new[] { "serve", "--https=" + url.Port, "off" }, Append);
            }
            try
            {
                LoginItem.Remove();
            }
            catch (Exception exception)
            {
                Append(exception.Message);
            }
            await Refresh();
        }

        /// <summary>
        /// The plugin's own stop, run here rather than queued in herdr (a herdr action only queues): it returns
        /// once the server and everything under it have exited, and fails when it cannot tell.
        /// </summary>
        private async Task<bool> Stop(Plugin plugin)
        {
            return (await Run.Program("bun", new[] { PluginScript(plugin), "stop" }, Append)).Status == 0;
        }

        private static string[] PowerShell(string command)
        {
            // TLS 1.2 for Windows PowerShell on Windows 10, and UTF-8 output for the log
            var script = "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; " +
                         "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ProgressPreference = 'SilentlyContinue'; " + command;
            return new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Convert.ToBase64String(Encoding.Unicode.GetBytes(script)) };
        }

        private static string PluginScript(Plugin plugin)
        {
            return System.IO.Path.Combine(plugin.Root, "scripts", "plugin.ts");
        }

        /// <summary>herdr's plugin list names the plugin's checkout; releases up to 0.4.13 name it by the old id.</summary>
        internal static async Task<Plugin> FindPlugin()
        {
            var result = await Run.Program("herdr", new[] { "plugin", "list", "--json" }, null, false);
            if (result.Status != 0) return null;
            try
            {
                var json = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(result.Output);
                object answer, list;
                var plugins = json != null && json.TryGetValue("result", out answer) && answer is Dictionary<string, object> && ((Dictionary<string, object>)answer).TryGetValue("plugins", out list)
                    ? list as System.Collections.ArrayList
                    : null;
                if (plugins == null) return null;
                var listed = plugins.OfType<Dictionary<string, object>>().ToList();
                foreach (var id in new[] { Links.PluginId, Links.LegacyPluginId })
                {
                    var found = listed.FirstOrDefault(p => p.ContainsKey("plugin_id") && (p["plugin_id"] as string) == id);
                    if (found != null && found.ContainsKey("plugin_root") && found["plugin_root"] is string)
                    {
                        return new Plugin { Id = id, Root = (string)found["plugin_root"] };
                    }
                }
            }
            catch (Exception exception) when (exception is ArgumentException || exception is InvalidOperationException || exception is KeyNotFoundException || exception is InvalidCastException)
            {
                return null; // not the JSON this herdr is expected to print: treated as no plugin
            }
            return null;
        }

        /// <summary>`plugin.ts status` knows the port the plugin settled on: "running http://127.0.0.1:7317 (pid 1)" or "down …".</summary>
        private static async Task<Status> ReadStatus(Plugin plugin)
        {
            var result = await Run.Program("bun", new[] { PluginScript(plugin), "status" }, null, false);
            var words = (result.Output.Split('\n').FirstOrDefault() ?? "").Split(' ');
            var status = new Status { Running = words[0] == "running", Origin = words.Length > 1 ? words[1] : null };
            if (!status.Running || status.Origin == null) return status;
            try
            {
                using (var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) })
                {
                    var body = await client.GetStringAsync(status.Origin.TrimEnd('/') + "/api/access");
                    var access = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body);
                    object value;
                    var tailscale = access != null && access.TryGetValue("tailscale", out value) ? value as Dictionary<string, object> : null;
                    if (tailscale != null)
                    {
                        status.Tailscale = tailscale.ContainsKey("state") ? tailscale["state"] as string : null;
                        status.PhoneUrl = tailscale.ContainsKey("serving_url") ? tailscale["serving_url"] as string : null;
                    }
                }
            }
            catch (Exception exception) when (exception is HttpRequestException || exception is TaskCanceledException || exception is ArgumentException || exception is KeyNotFoundException || exception is InvalidOperationException)
            {
                // the app answers its status but not this: show it running, without a phone address
            }
            return status;
        }

        internal static async Task<bool> HerdrRunning()
        {
            var result = await Run.Program("herdr", new[] { "status", "server", "--json" }, null, false);
            return result.Output.Replace(" ", "").Contains("\"running\":true");
        }

        /// <summary>herdr starts the app from its startup hook; give it up to two minutes, checking every two seconds.</summary>
        private static async Task WaitUntilRunning()
        {
            for (var attempt = 0; attempt < 60; attempt++)
            {
                var found = await FindPlugin();
                if (found != null && (await ReadStatus(found)).Running) return;
                await Task.Delay(2000);
            }
        }

        private void Set(Phase phase, string title = null)
        {
            Phase = phase;
            Title = title;
            var changed = Changed;
            if (changed != null) changed();
        }

        private void Fail(string message, string detail = null)
        {
            if (detail != null) Append(detail);
            Set(Phase.Failed, message);
        }

        private void ClearLog()
        {
            lock (log) log.Clear();
        }

        /// <summary>Called on the pipe's thread for each line a child prints; shown on the window's thread, in order.</summary>
        private void Append(string line)
        {
            // a QR code drawn in block characters means nothing in a log
            if (line.Length == 0 || line.All(c => "█▀▄ ".IndexOf(c) >= 0)) return;
            lock (log) log.Add(line);
            context.Post(_ =>
            {
                var added = LineAdded;
                if (added != null) added(line);
            }, null);
        }
    }
}

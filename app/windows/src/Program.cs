using System;
using System.Linq;
using System.Windows.Forms;

namespace Ovis
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Contains("--start")) return StartAtLogin();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
            LoginItem.FinishDeleteOnExit();
            return 0;
        }

        /// <summary>
        /// The login start, with no window: herdr's server when the Ovis server is installed and herdr is not
        /// running yet. A herdr that runs is left as it is. After Remove (the MSIX keeps its startup task) it
        /// does nothing.
        /// </summary>
        private static int StartAtLogin()
        {
            Paths.RefreshPath();
            if (Paths.Which("herdr") == null) return 0;
            if (Model.FindPlugin().GetAwaiter().GetResult() == null) return 0;
            if (Model.HerdrRunning().GetAwaiter().GetResult()) return 0;
            Run.Detached("herdr", new[] { "server" });
            return 0;
        }
    }
}

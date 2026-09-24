using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Program
{
    internal static readonly string ToolsRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    internal static readonly string BatchPath = ToolsRoot + @"\fix-codex.bat";
    internal static readonly string ScriptPath = ToolsRoot + @"\codex-selfheal.ps1";
    internal static readonly string StatePath = ToolsRoot + @"\codex-tray-state.json";

    [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr icon);

    internal static Icon MakeIcon(Color color)
    {
        using (Bitmap bitmap = new Bitmap(32, 32))
        using (Graphics g = Graphics.FromImage(bitmap))
        using (Brush background = new SolidBrush(color))
        using (Font font = new Font("Segoe UI", 21, FontStyle.Bold, GraphicsUnit.Pixel))
        using (StringFormat format = new StringFormat())
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            g.Clear(Color.Transparent);
            g.FillEllipse(background, 1, 1, 30, 30);
            format.Alignment = StringAlignment.Center;
            format.LineAlignment = StringAlignment.Center;
            g.DrawString("C", font, Brushes.White, new RectangleF(0, -1, 32, 32), format);
            IntPtr native = bitmap.GetHicon();
            try { using (Icon icon = Icon.FromHandle(native)) return (Icon)icon.Clone(); }
            finally { DestroyIcon(native); }
        }
    }

    internal static ProcessStartInfo BuildStartInfo(bool checkOnly)
    {
        ProcessStartInfo info;
        if (checkOnly)
        {
            info = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"),
                "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + ScriptPath + "\" -NoRestart");
        }
        else
        {
            info = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"),
                "/d /s /c \"\"" + BatchPath + "\" --quiet\"");
        }
        info.WorkingDirectory = ToolsRoot;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.WindowStyle = ProcessWindowStyle.Hidden;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.StandardOutputEncoding = Encoding.UTF8;
        info.StandardErrorEncoding = Encoding.UTF8;
        return info;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--export-icon")
        {
            using (Icon icon = MakeIcon(Color.FromArgb(40, 112, 235)))
            using (FileStream file = File.Create(args[1])) icon.Save(file);
            return 0;
        }
        if (args.Length == 2 && args[0] == "--self-test")
        {
            var command = BuildStartInfo(false);
            using (var process = new Process { StartInfo = BuildStartInfo(true) })
            {
                process.Start();
                string output = process.StandardOutput.ReadToEnd();
                string error = process.StandardError.ReadToEnd();
                process.WaitForExit();
                File.WriteAllText(args[1], new JavaScriptSerializer().Serialize(new {
                    passed = process.ExitCode == 0 && File.Exists(BatchPath), exitCode = process.ExitCode,
                    output = output, error = error, repairExecutable = command.FileName,
                    repairArguments = command.Arguments, hidden = command.CreateNoWindow,
                    shellExecute = command.UseShellExecute
                }), new UTF8Encoding(false));
                return process.ExitCode;
            }
        }
        bool created;
        using (var singleton = new Mutex(true, @"Local\CodexRecoveryTray.SingleInstance", out created))
        {
            if (!created) return 0;
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new RecoveryTray());
            }
            finally { singleton.ReleaseMutex(); }
        }
        return 0;
    }
}

internal sealed class RecoveryTray : ApplicationContext
{
    private readonly NotifyIcon tray;
    private readonly Icon readyIcon = Program.MakeIcon(Color.FromArgb(40, 112, 235));
    private readonly Icon busyIcon = Program.MakeIcon(Color.FromArgb(221, 145, 20));
    private readonly Icon errorIcon = Program.MakeIcon(Color.FromArgb(210, 61, 70));
    private readonly Control dispatcher = new Control();
    private readonly ToolStripMenuItem repairItem;
    private readonly ToolStripMenuItem checkItem;
    private readonly ToolStripMenuItem exitItem;
    private readonly System.Windows.Forms.Timer registrationTimer;
    private readonly System.Windows.Forms.Timer protectionTimer;
    private readonly CodexResponseProtection protection;
    private readonly ToolStripMenuItem protectionItem;
    private readonly ToolStripMenuItem protectionStatusItem;
    private readonly object logLock = new object();
    private bool busy;
    private bool promoted;
    private string lastLog;
    private int? lastExitCode;
    private int? workerPid;
    private DateTime lastClick = DateTime.MinValue;
    private int registrationTries;

    [StructLayout(LayoutKind.Sequential)] private struct IconIdentifier { public uint size; public IntPtr hwnd; public uint id; public Guid guid; }
    [StructLayout(LayoutKind.Sequential)] private struct IconRect { public int left, top, right, bottom; }
    [DllImport("shell32.dll")] private static extern int Shell_NotifyIconGetRect(ref IconIdentifier identifier, out IconRect rect);

    public RecoveryTray()
    {
        IntPtr ignored = dispatcher.Handle;
        tray = new NotifyIcon { Icon = readyIcon, Text = "Codex 修复 · 单击修复，右键菜单" };
        ContextMenuStrip menu = new ContextMenuStrip();
        repairItem = new ToolStripMenuItem("修复 Codex", null, delegate { BeginRepair(false); });
        checkItem = new ToolStripMenuItem("检查状态（不重启）", null, delegate { BeginRepair(true); });
        menu.Items.Add(repairItem);
        menu.Items.Add(checkItem);
        protection = new CodexResponseProtection(delegate {
            try { dispatcher.BeginInvoke(new Action(delegate {
                protectionItem.Checked = protection.Enabled;
                protectionItem.Enabled = !busy && !protection.Working;
                protectionStatusItem.Text = "自动保护：" + protection.Status;
                exitItem.Enabled = !busy && !protection.Working;
                SaveState();
            })); } catch (InvalidOperationException) { }
        });
        protectionItem = new ToolStripMenuItem("自动补齐丢失回复（不重启）");
        protectionItem.Checked = protection.Enabled;
        protectionItem.Click += delegate {
            try { protection.SetEnabled(!protection.Enabled); protection.Poll(); }
            catch (Exception error) { tray.ShowBalloonTip(4000,"自动保护设置未完成",error.Message,ToolTipIcon.Error); }
        };
        protectionStatusItem = new ToolStripMenuItem("自动保护：" + protection.Status) { Enabled = false };
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(protectionItem);
        menu.Items.Add(protectionStatusItem);
        menu.Items.Add("查看自动保护记录", null, delegate { OpenFile(Path.Combine(Program.ToolsRoot, "codex-response-guard.log")); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("打开最新诊断文件夹", null, delegate { OpenDiagnostics(); });
        menu.Items.Add("查看修复记录", null, delegate { OpenFile(lastLog ?? Path.Combine(Program.ToolsRoot, "codex-selfheal.log")); });
        menu.Items.Add(new ToolStripSeparator());
        exitItem = new ToolStripMenuItem("退出托盘按钮", null, delegate { ExitThread(); });
        menu.Items.Add(exitItem);
        tray.ContextMenuStrip = menu;
        tray.MouseClick += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) BeginRepair(false); };
        tray.BalloonTipClicked += delegate { if (!busy) OpenDiagnostics(); };
        tray.Visible = true;
        SaveState();
        registrationTimer = new System.Windows.Forms.Timer { Interval = 2000 };
        registrationTimer.Tick += delegate {
            registrationTries++;
            if (!promoted) promoted = PromoteOwnIcon();
            SaveState();
            if (promoted || registrationTries >= 15) registrationTimer.Stop();
        };
        registrationTimer.Start();
        protectionTimer = new System.Windows.Forms.Timer { Interval = 3000 };
        protectionTimer.Tick += delegate { if (!busy) protection.Poll(); };
        protectionTimer.Start();
        protection.Poll();
    }

    private void BeginRepair(bool checkOnly)
    {
        if (busy || DateTime.UtcNow - lastClick < TimeSpan.FromSeconds(2)) return;
        if (protection.Working) {
            tray.ShowBalloonTip(2500,"正在启用自动保护","几秒后即可手动修复，当前任务保持运行。",ToolTipIcon.Info);
            return;
        }
        lastClick = DateTime.UtcNow;
        if (!File.Exists(Program.BatchPath) || !File.Exists(Program.ScriptPath))
        {
            tray.ShowBalloonTip(5000, "找不到 Codex 修复文件", "请检查安装文件夹里的修复脚本。", ToolTipIcon.Error);
            return;
        }
        busy = true;
        repairItem.Enabled = checkItem.Enabled = exitItem.Enabled = false;
        protectionItem.Enabled = false;
        tray.Icon = busyIcon;
        tray.Text = checkOnly ? "Codex 修复 · 正在检查状态" : "Codex 修复 · 正在保存日志并恢复";
        lastLog = Path.Combine(Program.ToolsRoot, "codex-tray-runs", DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + ".log");
        Directory.CreateDirectory(Path.GetDirectoryName(lastLog));
        string runLog = lastLog;
        File.WriteAllText(runLog, DateTime.Now.ToString("o") + (checkOnly ? " CHECK ONLY\r\n" : " REPAIR\r\n"), new UTF8Encoding(true));
        SaveState();
        tray.ShowBalloonTip(3500, checkOnly ? "正在检查 Codex" : "已开始修复 Codex",
            checkOnly ? "当前任务会保留。" : "先保存日志，再尝试原地恢复；必要时会自动重开 Codex。", ToolTipIcon.Info);
        Task.Factory.StartNew(delegate {
            int code = -1;
            try
            {
                using (Process child = new Process { StartInfo = Program.BuildStartInfo(checkOnly) })
                {
                    child.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { AppendLog(runLog, e.Data); };
                    child.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { AppendLog(runLog, e.Data); };
                    child.Start();
                    int startedPid = child.Id;
                    dispatcher.BeginInvoke(new Action(delegate { workerPid = startedPid; SaveState(); }));
                    child.BeginOutputReadLine(); child.BeginErrorReadLine();
                    child.WaitForExit();
                    code = child.ExitCode;
                }
            }
            catch (Exception error) { AppendLog(runLog, error.ToString()); }
            int result = code;
            dispatcher.BeginInvoke(new Action(delegate {
                busy = false; workerPid = null; lastExitCode = result;
                repairItem.Enabled = checkItem.Enabled = exitItem.Enabled = true;
                protectionItem.Enabled = !protection.Working;
                tray.Icon = result == 0 ? readyIcon : errorIcon;
                tray.Text = result == 0 ? "Codex 修复 · 单击修复，右键菜单" : "Codex 修复 · 上次未完成，右键查看记录";
                SaveState();
                tray.ShowBalloonTip(5000, result == 0 ? (checkOnly ? "检查完成" : "Codex 恢复流程已完成") : "Codex 修复未完成",
                    result == 0 ? (checkOnly ? "当前任务保持运行。" : "请回到原对话试着发送。右键可查看日志。") : "右键选择“查看修复记录”可查看具体原因。", result == 0 ? ToolTipIcon.Info : ToolTipIcon.Error);
            }));
        });
    }

    private void AppendLog(string file, string line)
    {
        if (line == null) return;
        lock (logLock) File.AppendAllText(file, line + Environment.NewLine, new UTF8Encoding(false));
    }

    private void OpenDiagnostics()
    {
        string marker = Path.Combine(Program.ToolsRoot, "codex-last-diagnostic.txt");
        string folder = File.Exists(marker) ? File.ReadAllText(marker).Trim() : Path.Combine(Program.ToolsRoot, "diagnostics");
        if (!folder.StartsWith((Path.Combine(Program.ToolsRoot, "diagnostics") + Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase) || !Directory.Exists(folder)) folder = Path.Combine(Program.ToolsRoot, "diagnostics");
        Directory.CreateDirectory(folder);
        Process.Start(new ProcessStartInfo("explorer.exe", "\"" + folder + "\"") { UseShellExecute = true });
    }

    private void OpenFile(string path)
    {
        if (File.Exists(path)) Process.Start(new ProcessStartInfo("notepad.exe", "\"" + path + "\"") { UseShellExecute = true });
        else OpenDiagnostics();
    }

    private bool PromoteOwnIcon()
    {
        try
        {
            string ownExe = Path.GetFullPath(Application.ExecutablePath);
            using (RegistryKey parent = Registry.CurrentUser.OpenSubKey(@"Control Panel\NotifyIconSettings"))
            {
                if (parent == null) return false;
                foreach (string child in parent.GetSubKeyNames())
                using (RegistryKey entry = parent.OpenSubKey(child, true))
                {
                    string path = entry.GetValue("ExecutablePath") as string;
                    if (String.IsNullOrEmpty(path)) continue;
                    if (!String.Equals(Path.GetFullPath(Environment.ExpandEnvironmentVariables(path)), ownExe, StringComparison.OrdinalIgnoreCase)) continue;
                    entry.SetValue("IsPromoted", 1, RegistryValueKind.DWord);
                    tray.Visible = false; tray.Visible = true;
                    return true;
                }
            }
        }
        catch (Exception error) { AppendLog(Path.Combine(Program.ToolsRoot, "codex-tray.log"), error.Message); }
        return false;
    }

    private void SaveState()
    {
        try
        {
            int rectResult = -1;
            IconRect rect = new IconRect();
            FieldInfo windowField = typeof(NotifyIcon).GetField("window", BindingFlags.Instance | BindingFlags.NonPublic);
            FieldInfo idField = typeof(NotifyIcon).GetField("id", BindingFlags.Instance | BindingFlags.NonPublic);
            if (windowField != null && idField != null)
            {
                NativeWindow window = windowField.GetValue(tray) as NativeWindow;
                if (window != null)
                {
                    IconIdentifier identifier = new IconIdentifier { size = (uint)Marshal.SizeOf(typeof(IconIdentifier)), hwnd = window.Handle, id = (uint)(int)idField.GetValue(tray) };
                    rectResult = Shell_NotifyIconGetRect(ref identifier, out rect);
                }
            }
            File.WriteAllText(Program.StatePath, new JavaScriptSerializer().Serialize(new {
                updatedAt = DateTime.Now.ToString("o"), pid = Process.GetCurrentProcess().Id,
                busy = busy, workerPid = workerPid, lastExitCode = lastExitCode, lastLog = lastLog,
                automaticProtection = new { enabled = protection.Enabled, status = protection.Status, targetPid = protection.TargetPid, working = protection.Working },
                visibleRequested = tray.Visible, promoted = promoted, iconRectResult = rectResult,
                iconBounds = new { left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom },
                tooltip = tray.Text
            }), new UTF8Encoding(false));
        }
        catch (Exception error) { AppendLog(Path.Combine(Program.ToolsRoot, "codex-tray.log"), error.Message); }
    }

    protected override void ExitThreadCore()
    {
        registrationTimer.Stop(); registrationTimer.Dispose();
        protectionTimer.Stop(); protectionTimer.Dispose();
        tray.Visible = false; tray.Dispose();
        readyIcon.Dispose(); busyIcon.Dispose(); errorIcon.Dispose();
        dispatcher.Dispose();
        base.ExitThreadCore();
    }
}

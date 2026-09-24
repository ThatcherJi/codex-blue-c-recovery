using System;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

// Attaches once per verified desktop process. The helper closes its diagnostic port after installation.
internal sealed class CodexResponseProtection
{
    internal static readonly string DisabledPath = Program.ToolsRoot + @"\codex-response-protection.disabled";
    private static readonly string HelperPath = Program.ToolsRoot + @"\install-codex-response-protection.mjs";
    private static string NodePath { get { string config = Path.Combine(Program.ToolsRoot, "node-path.txt"); return File.Exists(config) ? File.ReadAllText(config).Trim() : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"nodejs\node.exe"); } }
    private readonly Action changed;
    private string processKey;
    private int attempts;
    private DateTime nextAttempt = DateTime.MinValue;
    private bool installed;
    private DateTime verifiedStart;
    private volatile bool working;
    private volatile bool enabled;
    internal string Status = "等待 Codex";
    internal int? TargetPid;
    internal bool Enabled { get { return enabled; } }
    internal bool Working { get { return working; } }

    internal CodexResponseProtection(Action onChanged)
    {
        changed = onChanged;
        enabled = !File.Exists(DisabledPath);
        if (!enabled) Status = "已关闭";
    }

    internal void SetEnabled(bool value)
    {
        if (working) return;
        enabled = value;
        if (value) { if (File.Exists(DisabledPath)) File.Delete(DisabledPath); installed = false; attempts = 0; nextAttempt = DateTime.MinValue; Status = "等待启用"; }
        else { File.WriteAllText(DisabledPath, DateTime.Now.ToString("o"), new UTF8Encoding(false)); Status = "已关闭"; }
        changed();
        if (!value && TargetPid.HasValue)
        {
            working = true;
            int target = TargetPid.Value;
            Task.Factory.StartNew(delegate { try { RunHelper(target, true); } finally { installed = false; working = false; changed(); } });
        }
    }

    internal void Poll()
    {
        if (!enabled || working) return;
        working = true;
        Task.Factory.StartNew(delegate {
            try
            {
                if (installed && TargetPid.HasValue)
                {
                    try { using (var live = Process.GetProcessById(TargetPid.Value)) { if (!live.HasExited && live.StartTime.ToUniversalTime() == verifiedStart) return; } }
                    catch (ArgumentException) { }
                    catch (InvalidOperationException) { }
                    installed = false;
                }
                if (DateTime.UtcNow < nextAttempt) return;
                int pid = 0; string key = null; int matches = 0;
                using (var search = new ManagementObjectSearcher("SELECT ProcessId,ExecutablePath,CommandLine,CreationDate FROM Win32_Process WHERE Name='ChatGPT.exe'"))
                using (var results = search.Get())
                foreach (ManagementObject process in results)
                {
                    string path = process["ExecutablePath"] as string;
                    string command = process["CommandLine"] as string;
                    if (String.IsNullOrEmpty(path) || String.IsNullOrEmpty(command) || command.IndexOf("--type=", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                    if (!Regex.IsMatch(path, @"\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$", RegexOptions.IgnoreCase)) continue;
                    matches++; pid = Convert.ToInt32(process["ProcessId"]);
                    key = pid.ToString() + ":" + Convert.ToString(process["CreationDate"]);
                }
                if (matches != 1) { TargetPid = null; Status = matches == 0 ? "等待 Codex" : "保留手动修复（多个主进程）"; return; }
                TargetPid = pid;
                if (key != processKey) { processKey = key; installed = false; attempts = 0; nextAttempt = DateTime.MinValue; }
                if (installed || attempts >= 4 || DateTime.UtcNow < nextAttempt) return;
                attempts++; Status = "正在启用"; changed();
                int code = RunHelper(pid, false);
                if (code == 0) {
                    using (var live = Process.GetProcessById(pid)) verifiedStart = live.StartTime.ToUniversalTime();
                    installed = true; Status = "已启用";
                }
                else if (code == 3) { attempts = 4; Status = "新版待验证，可用手动修复"; }
                else { nextAttempt = DateTime.UtcNow.AddSeconds(15); Status = attempts >= 4 ? "启用未完成，可用手动修复" : "稍后重试启用"; }
            }
            catch (Exception error) { Status = "启用未完成，可用手动修复"; Log(error.Message); }
            finally { working = false; changed(); }
        });
    }

    private static void Log(string text)
    {
        try { File.AppendAllText(Program.ToolsRoot + @"\codex-response-protection-loader.log", DateTime.Now.ToString("o") + " " + text + Environment.NewLine, new UTF8Encoding(false)); } catch { }
    }

    private static int RunHelper(int pid, bool remove)
    {
        if (!File.Exists(NodePath) || !File.Exists(HelperPath)) { Log("Missing protection helper/runtime."); return 1; }
        var info = new ProcessStartInfo(NodePath, "\"" + HelperPath + "\" --pid=" + pid.ToString() + (remove ? " --remove" : ""));
        info.UseShellExecute = false; info.CreateNoWindow = true; info.WindowStyle = ProcessWindowStyle.Hidden;
        info.WorkingDirectory = Program.ToolsRoot; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
        info.StandardOutputEncoding = Encoding.UTF8; info.StandardErrorEncoding = Encoding.UTF8;
        using (var child = new Process { StartInfo = info })
        {
            child.Start();
            Task<string> output = child.StandardOutput.ReadToEndAsync();
            Task<string> error = child.StandardError.ReadToEndAsync();
            if (!child.WaitForExit(55000)) { child.Kill(); child.WaitForExit(); Log("Protection helper timed out; desktop was kept running."); return 1; }
            Log((remove ? "REMOVE " : "INSTALL ") + "pid=" + pid + " exit=" + child.ExitCode + " " + output.Result + error.Result);
            return child.ExitCode;
        }
    }
}

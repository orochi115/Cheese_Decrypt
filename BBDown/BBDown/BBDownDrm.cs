using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using static BBDown.Core.Logger;

namespace BBDown;

/// <summary>
/// B 站 cheese ClearKey DRM 解密相关辅助。当前阶段只覆盖手动 --key 路径:
/// 解析 --key 参数, 调 mp4decrypt 解密下载好的 mp4/m4a。
/// </summary>
internal static class BBDownDrm
{
    private const string KEY_WILDCARD = "*";
    private static bool? _availableCache;
    private static string? _availableProbedPath;
    private static bool? _nodeAvailableCache;
    private static string? _nodeProbedPath;

    /// <summary>
    /// 解析多个 --key 参数, 返回 KID(小写hex) -> KEY(小写hex) 映射。
    /// 支持两种形式:
    ///   "kid_hex:key_hex"  (32:32 严格)
    ///   "key_hex"          (单 32 位 hex, 存到通配符 KEY_WILDCARD, 仅一对 KID 时自动匹配)
    /// </summary>
    public static Dictionary<string, string> ParseKeyArgs(IEnumerable<string>? rawKeys)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (rawKeys == null) return map;
        foreach (var raw in rawKeys)
        {
            var s = (raw ?? "").Trim();
            if (string.IsNullOrEmpty(s)) continue;
            string kid, key;
            if (s.Contains(':'))
            {
                var parts = s.Split(':', 2);
                kid = parts[0].Trim().ToLowerInvariant();
                key = parts[1].Trim().ToLowerInvariant();
                if (!IsHex32(kid) || !IsHex32(key))
                {
                    LogWarn($"忽略格式错误的 --key 参数: {raw} (期望 32位hex:32位hex)");
                    continue;
                }
            }
            else
            {
                key = s.ToLowerInvariant();
                if (!IsHex32(key))
                {
                    LogWarn($"忽略格式错误的 --key 参数: {raw} (期望 32位hex 或 kid:key)");
                    continue;
                }
                kid = KEY_WILDCARD;
            }
            map[kid] = key;
        }
        return map;
    }

    /// <summary>
    /// 按 kid 取 key: 先精确匹配, 再 fallback 到通配符。
    /// </summary>
    public static string? ResolveKeyForKid(string kid, IReadOnlyDictionary<string, string> keys)
    {
        var k = kid.ToLowerInvariant();
        if (keys.TryGetValue(k, out var v)) return v;
        if (keys.TryGetValue(KEY_WILDCARD, out var w))
        {
            LogWarn($"使用通配符 --key 兜底匹配 KID={k}");
            return w;
        }
        return null;
    }

    /// <summary>
    /// 探测 mp4decrypt 是否可用, 缓存结果。
    /// </summary>
    public static bool IsAvailable(string mp4decryptPath)
    {
        if (_availableCache.HasValue && _availableProbedPath == mp4decryptPath) return _availableCache.Value;
        _availableProbedPath = mp4decryptPath;
        try
        {
            using var p = new Process();
            p.StartInfo.FileName = mp4decryptPath;
            p.StartInfo.UseShellExecute = false;
            p.StartInfo.CreateNoWindow = true;
            p.StartInfo.RedirectStandardOutput = true;
            p.StartInfo.RedirectStandardError = true;
            // mp4decrypt 不带参数会输出 usage 到 stderr 并以非 0 退出, 同样视为可用
            p.Start();
            if (!p.WaitForExit(5000))
            {
                try { p.Kill(true); } catch { }
                _availableCache = false;
                return false;
            }
            _availableCache = true;
            return true;
        }
        catch (Exception ex)
        {
            LogDebug("mp4decrypt 探测失败: {0}", ex.Message);
            _availableCache = false;
            return false;
        }
    }

    /// <summary>
    /// 调用 mp4decrypt 解密单个 mp4/m4a 文件。
    /// 返回 mp4decrypt 的退出码, 0 表示成功。
    /// </summary>
    public static int Decrypt(string mp4decryptPath, string kidHex, string keyHex, string inPath, string outPath)
    {
        var args = $"--key {kidHex}:{keyHex} \"{inPath}\" \"{outPath}\"";
        LogDebug("mp4decrypt 命令: {0} {1}", mp4decryptPath, args);
        try
        {
            using var p = new Process();
            p.StartInfo.FileName = mp4decryptPath;
            p.StartInfo.Arguments = args;
            p.StartInfo.UseShellExecute = false;
            p.StartInfo.RedirectStandardOutput = true;
            p.StartInfo.RedirectStandardError = true;
            p.StartInfo.CreateNoWindow = true;
            p.StartInfo.StandardOutputEncoding = Encoding.UTF8;
            p.StartInfo.StandardErrorEncoding = Encoding.UTF8;
            p.OutputDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) Log(e.Data); };
            p.ErrorDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) Log(e.Data); };
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            p.WaitForExit();
            return p.ExitCode;
        }
        catch (Exception ex)
        {
            LogError($"mp4decrypt 启动失败: {ex.Message}");
            return -1;
        }
    }

    /// <summary>
    /// 探测 node 是否可用, 缓存结果。
    /// </summary>
    public static bool IsNodeAvailable(string nodePath)
    {
        if (_nodeAvailableCache.HasValue && _nodeProbedPath == nodePath) return _nodeAvailableCache.Value;
        _nodeProbedPath = nodePath;
        try
        {
            using var p = new Process();
            p.StartInfo.FileName = nodePath;
            p.StartInfo.Arguments = "--version";
            p.StartInfo.UseShellExecute = false;
            p.StartInfo.CreateNoWindow = true;
            p.StartInfo.RedirectStandardOutput = true;
            p.StartInfo.RedirectStandardError = true;
            p.Start();
            if (!p.WaitForExit(5000)) { try { p.Kill(true); } catch { } _nodeAvailableCache = false; return false; }
            _nodeAvailableCache = p.ExitCode == 0;
            return _nodeAvailableCache.Value;
        }
        catch (Exception ex)
        {
            LogDebug("node 探测失败: {0}", ex.Message);
            _nodeAvailableCache = false;
            return false;
        }
    }

    /// <summary>
    /// 定位 bili-drm-helper.js: 优先 AppContext.BaseDirectory/scripts/, 其次相对源码 (../../../scripts/), 最后 cwd/scripts/。
    /// </summary>
    public static string? ResolveHelperScriptPath()
    {
        var candidates = new List<string>();
        var baseDir = AppContext.BaseDirectory;
        candidates.Add(Path.Combine(baseDir, "scripts", "bili-drm-helper.js"));
        // dotnet run / dev: bin/Debug/netX/.. → 项目根 → ../scripts/
        candidates.Add(Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "scripts", "bili-drm-helper.js")));
        candidates.Add(Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "..", "scripts", "bili-drm-helper.js")));
        candidates.Add(Path.Combine(Environment.CurrentDirectory, "scripts", "bili-drm-helper.js"));
        candidates.Add(Path.Combine(Environment.CurrentDirectory, "BBDown", "scripts", "bili-drm-helper.js"));
        foreach (var c in candidates)
        {
            if (File.Exists(c)) return c;
        }
        return null;
    }

    /// <summary>
    /// 串行调用 bili-drm-helper.js 自动取每个 KID 的 ClearKey, 返回 KID(小写) -> KEY(小写hex) 映射。
    /// 任何 KID 失败立即抛出 (附带 stderr 末尾以辅助诊断)。
    /// </summary>
    public static async Task<Dictionary<string, string>> AcquireKeysAutoAsync(
        IEnumerable<string> kids, string cookie, string nodePath, string helperScriptPath)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var distinct = new HashSet<string>(kids.Where(k => !string.IsNullOrEmpty(k)).Select(k => k.ToLowerInvariant()));
        foreach (var kid in distinct)
        {
            Log($"[--drm-auto] 取 KID {kid} 的 key (调 {Path.GetFileName(helperScriptPath)})...");
            var (rc, stdout, stderr) = await RunHelperAsync(nodePath, helperScriptPath,
                new[] { "get-key", "--kid", kid, "--cookie", cookie });
            var line = (stdout ?? "").Trim();
            if (rc != 0 || string.IsNullOrEmpty(line))
            {
                var tail = string.Join(" | ", (stderr ?? "")
                    .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .TakeLast(3));
                throw new Exception($"bili-drm-helper.js 取 KID {kid} 失败 (exit={rc}): {tail}");
            }
            var idx = line.IndexOf(':');
            if (idx != 32 || line.Length != 65)
            {
                throw new Exception($"bili-drm-helper.js 输出格式异常 (KID {kid}): {line}");
            }
            var k = line.Substring(0, 32).ToLowerInvariant();
            var v = line.Substring(33).ToLowerInvariant();
            if (!IsHex32(k) || !IsHex32(v)) throw new Exception($"bili-drm-helper.js 输出非 hex (KID {kid}): {line}");
            map[k] = v;
            Log($"[--drm-auto] {k}:{v}");
        }
        return map;
    }

    private static Task<(int code, string stdout, string stderr)> RunHelperAsync(
        string nodePath, string scriptPath, string[] args)
    {
        var tcs = new TaskCompletionSource<(int, string, string)>();
        var p = new Process();
        p.StartInfo.FileName = nodePath;
        p.StartInfo.ArgumentList.Add(scriptPath);
        foreach (var a in args) p.StartInfo.ArgumentList.Add(a);
        p.StartInfo.UseShellExecute = false;
        p.StartInfo.CreateNoWindow = true;
        p.StartInfo.RedirectStandardOutput = true;
        p.StartInfo.RedirectStandardError = true;
        p.StartInfo.StandardOutputEncoding = Encoding.UTF8;
        p.StartInfo.StandardErrorEncoding = Encoding.UTF8;
        var outBuf = new StringBuilder();
        var errBuf = new StringBuilder();
        p.OutputDataReceived += (_, e) => { if (e.Data != null) outBuf.AppendLine(e.Data); };
        p.ErrorDataReceived += (_, e) => { if (e.Data != null) { errBuf.AppendLine(e.Data); LogDebug("[helper.js] {0}", e.Data); } };
        p.EnableRaisingEvents = true;
        p.Exited += (_, _) =>
        {
            try { p.WaitForExit(); } catch { }
            tcs.TrySetResult((p.ExitCode, outBuf.ToString(), errBuf.ToString()));
            try { p.Dispose(); } catch { }
        };
        try
        {
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
        }
        catch (Exception ex)
        {
            tcs.TrySetResult((-1, "", $"启动 node 失败: {ex.Message}"));
        }
        return tcs.Task;
    }

    private static bool IsHex32(string s)
    {
        if (s.Length != 32) return false;
        foreach (var c in s)
        {
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
        }
        return true;
    }
}

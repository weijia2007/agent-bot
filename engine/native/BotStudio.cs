using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace NexusRelay;

/// <summary>
/// Dynamic bot identity registry for NexusBot Studio. The original engine hardcoded three agents;
/// this registry keeps those three aliases working (all existing tests rely on them) and adds
/// arbitrary bot_id values persisted in &lt;RelayHome&gt;/bots.json. All JSON is JsonNode based:
/// the project publishes with Native AOT and reflection-based serialization is forbidden.
/// </summary>
public static partial class BotRegistry
{
    public static readonly string[] LegacyAgents = ["claude", "antigravity", "codex"];
    public static readonly string[] EngineTypes = ["claude", "codex", "antigravity"];
    public static readonly string[] Statuses = ["idle", "working", "queued", "error", "paused", "waiting_approval"];

    // A bot_id becomes part of a message filename "<id>.<from>.<to>.<topic>.json", so dots,
    // uppercase characters and separators would break the file-name parser in RelayBox.
    [GeneratedRegex(@"^[a-z0-9][a-z0-9-]{0,47}$", RegexOptions.Compiled)]
    private static partial Regex BotIdRegex();

    private static readonly Lock Gate = new();

    public static string BotsPath => Path.Join(RelayPaths.RelayHome(), "bots.json");
    public static string ConfigPath => Path.Join(RelayPaths.RelayHome(), "config.json");
    public static string StopPath => Path.Join(RelayPaths.RelayHome(), "stop");

    public static bool IsValidId(string? id) => id is not null && BotIdRegex().IsMatch(id);
    public static bool IsLegacy(string? id) => id is not null && LegacyAgents.Contains(id, StringComparer.Ordinal);

    private static JsonObject LoadConfig()
    {
        try
        {
            if (File.Exists(ConfigPath))
                return JsonNode.Parse(File.ReadAllText(ConfigPath, Encoding.UTF8)) as JsonObject ?? new JsonObject();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        {
            // Ignore corrupt config; fall back cleanly to env vars / defaults.
        }
        return new JsonObject();
    }

    public static void SetConfig(int? maxHops, bool? spawnEnabled)
    {
        lock (Gate)
        {
            var cfg = LoadConfig();
            if (maxHops is >= 1 and <= 100) cfg["max_hops"] = maxHops.Value;
            if (spawnEnabled.HasValue) cfg["spawn_enabled"] = spawnEnabled.Value;
            Directory.CreateDirectory(Path.GetDirectoryName(ConfigPath)!);
            var temp = ConfigPath + ".tmp";
            File.WriteAllText(temp, cfg.ToJsonString(), new UTF8Encoding(false));
            File.Move(temp, ConfigPath, overwrite: true);
        }
        BotEvents.Publish("config_changed", new JsonObject
        {
            ["max_hops"] = MaxHops(),
            ["spawn_enabled"] = SpawnEnabled(),
        });
    }

    public static int MaxHops()
    {
        JsonObject cfg;
        lock (Gate) cfg = LoadConfig();
        if (cfg["max_hops"] is JsonValue val && val.TryGetValue<int>(out int configured) && configured is >= 1 and <= 100)
            return configured;
        var raw = Environment.GetEnvironmentVariable("NEXUS_BOT_MAX_HOPS");
        return int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out int value) && value is >= 1 and <= 100
            ? value
            : 10;
    }

    public static bool SpawnEnabled()
    {
        JsonObject cfg;
        lock (Gate) cfg = LoadConfig();
        if (cfg["spawn_enabled"] is JsonValue val && val.TryGetValue<bool>(out bool configured))
            return configured;
        return string.Equals(Environment.GetEnvironmentVariable("NEXUS_BOT_SPAWN_ENABLED")?.Trim(), "1", StringComparison.Ordinal);
    }

    public static JsonArray LoadBots()
    {
        try
        {
            if (File.Exists(BotsPath))
                return JsonNode.Parse(File.ReadAllText(BotsPath, Encoding.UTF8)) as JsonArray ?? new JsonArray();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        {
            // A corrupt or unreadable registry is treated as empty; never crash the daemon.
        }
        return new JsonArray();
    }

    private static void SaveBots(JsonArray bots)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(BotsPath)!);
        var temp = BotsPath + ".tmp";
        File.WriteAllText(temp, bots.ToJsonString(), new UTF8Encoding(false));
        File.Move(temp, BotsPath, overwrite: true);
    }

    private static JsonObject? FindLocked(string id)
        => LoadBots().OfType<JsonObject>().FirstOrDefault(
            b => string.Equals(b["bot_id"]?.ToString(), id, StringComparison.Ordinal));

    public static JsonObject? Find(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return null;
        lock (Gate) return FindLocked(id)?.DeepClone() as JsonObject;
    }

    public static bool IsRegistered(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return false;
        if (IsLegacy(id)) return true;
        if (!IsValidId(id)) return false;
        lock (Gate) return FindLocked(id) is not null;
    }

    public static string EngineOf(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return "claude";
        if (IsLegacy(id)) return id;
        return Find(id)?["engine_type"]?.ToString() ?? "claude";
    }

    /// <summary>Validate an as_bot declaration. A shared static MCP plugin may only declare an
    /// identity backed by the same engine; this prevents cross-engine impersonation.</summary>
    public static string ResolveAsBot(JsonObject args, string me)
    {
        var declared = args["as_bot"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(declared)) return me;
        var id = declared.Trim();
        if (!IsRegistered(id))
            throw new RelayError($"as_bot: '{id}' is not a registered bot");
        var declaredEngine = EngineOf(id);
        var baseEngine = EngineOf(me);
        if (!string.Equals(declaredEngine, baseEngine, StringComparison.Ordinal))
            throw new RelayError($"as_bot: '{id}' runs on {declaredEngine}, not {baseEngine}");
        return id;
    }

    public static JsonObject Register(JsonObject spec)
    {
        var id = spec["bot_id"]?.ToString() ?? "";
        if (!IsValidId(id))
            throw new RelayError("bot_id must match ^[a-z0-9][a-z0-9-]{0,47}$");
        if (IsLegacy(id))
            throw new RelayError("bot_id is reserved: claude, codex and antigravity are legacy aliases");
        var engine = spec["engine_type"]?.ToString() ?? "";
        if (!EngineTypes.Contains(engine, StringComparer.Ordinal))
            throw new RelayError("engine_type must be claude, codex or antigravity");
        var status = spec["status"]?.ToString() ?? "idle";
        if (!Statuses.Contains(status, StringComparer.Ordinal)) status = "idle";

        var entry = new JsonObject
        {
            ["bot_id"] = id,
            ["display_name"] = spec["display_name"]?.ToString() ?? id,
            ["engine_type"] = engine,
            ["role"] = spec["role"]?.ToString() ?? "worker",
            ["status"] = status,
            ["workspace"] = spec["workspace"]?.ToString() ?? "",
            ["room"] = spec["room"]?.ToString() ?? "default",
            ["is_supervisor"] = spec["is_supervisor"]?.GetValue<bool>() ?? false,
            ["external_session_id"] = spec["external_session_id"]?.ToString() ?? "",
            ["bound"] = spec["bound"]?.GetValue<bool>() ?? false,
            ["updated_at"] = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
        };
        lock (Gate)
        {
            var bots = LoadBots();
            int index = -1;
            for (int i = 0; i < bots.Count; i++)
            {
                if (string.Equals(bots[i]?["bot_id"]?.ToString(), id, StringComparison.Ordinal)) { index = i; break; }
            }
            if (index >= 0) bots[index] = entry.DeepClone();
            else bots.Add(entry.DeepClone());
            SaveBots(bots);
        }
        BotEvents.Publish("bot_registered", (JsonObject)entry.DeepClone());
        return (JsonObject)entry.DeepClone();
    }

    public static bool Unregister(string id)
    {
        bool removed;
        lock (Gate)
        {
            var bots = LoadBots();
            var kept = new JsonArray();
            removed = false;
            foreach (var node in bots)
            {
                if (node is JsonObject obj && string.Equals(obj["bot_id"]?.ToString(), id, StringComparison.Ordinal))
                {
                    removed = true;
                    continue;
                }
                kept.Add(node?.DeepClone());
            }
            if (removed) SaveBots(kept);
        }
        if (removed) BotEvents.Publish("bot_unregistered", new JsonObject { ["bot_id"] = id });
        return removed;
    }

    public static JsonArray List(string? room = null)
    {
        var result = new JsonArray();
        foreach (var legacy in LegacyAgents)
        {
            if (room is not null && room != "default") continue;
            // Explicit JsonNode binding selects the non-generic IList<JsonNode?>.Add: the generic
            // Add<T>(T) would create a JsonValue at runtime and break Native AOT (IL2026/IL3050).
            JsonNode entry = new JsonObject
            {
                ["bot_id"] = legacy,
                ["display_name"] = legacy,
                ["engine_type"] = legacy,
                ["role"] = "legacy-peer",
                ["status"] = "idle",
                ["workspace"] = "",
                ["room"] = "default",
                ["is_supervisor"] = false,
                ["bound"] = false,
                ["legacy"] = true,
            };
            result.Add(entry);
        }
        lock (Gate)
        {
            foreach (var node in LoadBots())
            {
                if (node is not JsonObject bot) continue;
                if (!string.IsNullOrWhiteSpace(room) && bot["room"]?.ToString() != room) continue;
                result.Add(bot.DeepClone());
            }
        }
        return result;
    }

    public static void SetStatus(string id, string status)
    {
        if (!IsValidId(id) || IsLegacy(id)) return;
        var bot = Find(id);
        if (bot is null) return;
        bot["status"] = Statuses.Contains(status, StringComparer.Ordinal) ? status : "idle";
        bot["updated_at"] = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        Register(bot);
    }

    public static string NewTraceId() => Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(8));

    public static void SetEmergencyStop(bool active)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(StopPath)!);
        if (active)
            File.WriteAllText(StopPath, DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture), new UTF8Encoding(false));
        else
        {
            try { File.Delete(StopPath); } catch (FileNotFoundException) { /* already clear */ }
        }
        BotEvents.Publish("emergency_stop", new JsonObject { ["active"] = active });
    }

    public static bool EmergencyStopActive()
    {
        if (File.Exists(StopPath) && DateTime.UtcNow - File.GetLastWriteTimeUtc(StopPath) < TimeSpan.FromSeconds(120))
            return true;
        return AppTransport.EmergencyStop();
    }
}

/// <summary>Lock-free in-process event bus feeding the /api/events SSE stream. No external package:
/// System.Threading.Channels / ConcurrentQueue / SemaphoreSlim are all in the shared framework,
/// which keeps the locked restore and the AOT analyzers happy.</summary>
public static class BotEvents
{
    private static readonly ConcurrentDictionary<int, Subscription> Subscribers = new();
    private static int nextId;
    private static long sequence;

    public sealed class Subscription : IDisposable
    {
        internal readonly int Key;
        internal readonly ConcurrentQueue<JsonObject> Pending = new();
        internal readonly SemaphoreSlim Signal = new(0);
        internal Subscription(int key) => Key = key;

        public async Task<JsonObject?> NextAsync(TimeSpan timeout, CancellationToken token)
        {
            if (!await Signal.WaitAsync(timeout, token).ConfigureAwait(false)) return null;
            return Pending.TryDequeue(out var ev) ? ev : null;
        }

        public void Dispose()
        {
            Subscribers.TryRemove(Key, out _);
            Signal.Dispose();
        }
    }

    public static Subscription Subscribe()
    {
        int key = Interlocked.Increment(ref nextId);
        var sub = new Subscription(key);
        Subscribers[key] = sub;
        return sub;
    }

    public static int SubscriberCount => Subscribers.Count;

    public static void Publish(string type, JsonObject data)
    {
        if (Subscribers.IsEmpty) return;
        var ev = new JsonObject
        {
            ["seq"] = Interlocked.Increment(ref sequence),
            ["type"] = type,
            ["at"] = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
            ["data"] = data.DeepClone(),
        };
        foreach (var sub in Subscribers.Values)
        {
            sub.Pending.Enqueue((JsonObject)ev.DeepClone());
            sub.Signal.Release();
        }
    }
}

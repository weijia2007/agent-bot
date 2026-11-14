using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;

namespace NexusRelay;

/// <summary>
/// Control + event surface used only by the Electron orchestrator. All routes sit behind the
/// existing Bearer token check in McpServer.HandleHttpClientAsync and the listener is bound to
/// IPAddress.Loopback, so nothing here is reachable from the network.
/// </summary>
public static class BotControl
{
    private static readonly string[] ControlRoots =
        ["/api/bots", "/api/messages", "/api/search", "/api/locks", "/api/emergency-stop", "/api/quotas", "/api/events", "/api/engine"];

    public static bool IsControlPath(string path)
        => ControlRoots.Any(root => path == root || path.StartsWith(root + "/", StringComparison.Ordinal));

    private static JsonObject ParseBody(byte[] body, int length)
    {
        if (length <= 0) return new JsonObject();
        try
        {
            return JsonNode.Parse(Encoding.UTF8.GetString(body, 0, length)) as JsonObject ?? new JsonObject();
        }
        catch (System.Text.Json.JsonException)
        {
            throw new RelayError("invalid JSON body");
        }
    }

    private static async Task ReplyAsync(NetworkStream stream, int status, JsonObject payload)
        => await McpServer.WriteHttpResponseAsync(stream, status, "application/json; charset=utf-8",
            Encoding.UTF8.GetBytes(payload.ToJsonString()));

    private static string? QueryValue(string query, string key)
        => McpServer.ParseQueryParam(query, key);

    public static async Task HandleAsync(NetworkStream stream, string method, string path, string query,
        byte[] body, int length, CancellationToken token)
    {
        try
        {
            if (path == "/api/events" && method == "GET")
            {
                await EventsAsync(stream, token);
                return;
            }

            var request = method is "POST" or "PUT" or "PATCH" ? ParseBody(body, length) : new JsonObject();

            if (path == "/api/bots" && method == "GET")
            {
                await ReplyAsync(stream, 200, new JsonObject
                {
                    ["status"] = "success",
                    ["bots"] = BotRegistry.List(QueryValue(query, "room")),
                    ["max_hops"] = BotRegistry.MaxHops(),
                });
                return;
            }

            if (path == "/api/bots/register" && method == "POST")
            {
                await ReplyAsync(stream, 200, new JsonObject
                {
                    ["status"] = "success",
                    ["bot"] = BotRegistry.Register(request),
                });
                return;
            }

            if (path == "/api/bots/status" && method == "POST")
            {
                var id = request["bot_id"]?.ToString() ?? "";
                if (!BotRegistry.IsRegistered(id)) throw new RelayError($"unknown bot_id: {id}");
                BotRegistry.SetStatus(id, request["status"]?.ToString() ?? "idle");
                await ReplyAsync(stream, 200, new JsonObject { ["status"] = "success", ["bot"] = BotRegistry.Find(id)?.DeepClone() });
                return;
            }

            if (path.StartsWith("/api/bots/", StringComparison.Ordinal) && method == "DELETE")
            {
                var id = path["/api/bots/".Length..];
                if (!BotRegistry.IsValidId(id)) throw new RelayError("invalid bot_id");
                await ReplyAsync(stream, 200, new JsonObject { ["status"] = "success", ["removed"] = BotRegistry.Unregister(id) });
                return;
            }

            if (path == "/api/messages/user" && method == "POST")
            {
                await PostUserMessageAsync(stream, request);
                return;
            }

            if (path == "/api/messages" && method == "GET")
            {
                var box = new RelayBox();
                var rawTopic = QueryValue(query, "topic");
                var topicFilter = !string.IsNullOrEmpty(rawTopic) ? RelayBox.CheckTopic(rawTopic) : null;
                int limit = int.TryParse(QueryValue(query, "limit"), out int lim) ? Math.Clamp(lim, 1, 500) : 200;
                var list = (topicFilter is not null ? box.TopicMessages(topicFilter) : box.All())
                    .OrderBy(m => m.Created, StringComparer.Ordinal)
                    .TakeLast(limit)
                    .ToList();
                var arr = new JsonArray();
                foreach (var m in list) arr.Add((JsonNode)m.ToJson());
                await ReplyAsync(stream, 200, new JsonObject { ["status"] = "success", ["messages"] = arr });
                return;
            }

            if (path == "/api/search" && method == "GET")
            {
                var box = new RelayBox();
                var q = QueryValue(query, "q") ?? QueryValue(query, "query") ?? "";
                var rawTopic = QueryValue(query, "topic");
                var rawSender = QueryValue(query, "sender");
                int limit = int.TryParse(QueryValue(query, "limit"), out int lim) ? Math.Clamp(lim, 1, 100) : 20;
                var (total, hits) = SearchAndSummary.SearchPage(
                    box,
                    q,
                    !string.IsNullOrEmpty(rawTopic) ? RelayBox.CheckTopic(rawTopic) : null,
                    !string.IsNullOrEmpty(rawSender) ? RelayPaths.NormalizeParty(rawSender) : null,
                    limit);
                var arr = new JsonArray();
                foreach (var (m, score, extract) in hits)
                {
                    var item = new JsonObject
                    {
                        ["id"] = m.Id,
                        ["from"] = m.Sender,
                        ["to"] = m.To,
                        ["topic"] = m.Topic,
                        ["created"] = m.Created,
                        ["score"] = score,
                        ["snippet"] = extract,
                    };
                    if (!string.IsNullOrEmpty(m.ReplyTo)) item["reply_to"] = m.ReplyTo;
                    arr.Add((JsonNode)item);
                }
                await ReplyAsync(stream, 200, new JsonObject
                {
                    ["status"] = "success",
                    ["engine"] = "fts5",
                    ["total"] = total,
                    ["hits"] = arr,
                });
                return;
            }

            if (path == "/api/locks" && method == "GET")
            {
                var box = new RelayBox();
                await ReplyAsync(stream, 200, new JsonObject
                {
                    ["status"] = "success",
                    ["locks"] = McpServer.ActiveReservationsArray(box),
                });
                return;
            }

            if (path.StartsWith("/api/locks/", StringComparison.Ordinal) && method == "DELETE")
            {
                var lockId = Uri.UnescapeDataString(path["/api/locks/".Length..]).Trim();
                if (string.IsNullOrEmpty(lockId)) throw new RelayError("lock id is required");
                var box = new RelayBox();
                var released = Reservations.Release(box, RelayPaths.User, lockId, force: true);
                BotEvents.Publish("locks_changed", new JsonObject { ["active"] = McpServer.ActiveReservationsArray(box) });
                var arr = new JsonArray();
                foreach (var r in released) arr.Add((JsonNode)r);
                await ReplyAsync(stream, 200, new JsonObject { ["status"] = "success", ["released"] = arr });
                return;
            }

            if (path == "/api/emergency-stop" && method is "POST" or "DELETE")
            {
                bool active = method == "POST";
                BotRegistry.SetEmergencyStop(active);
                await ReplyAsync(stream, 200, new JsonObject
                {
                    ["status"] = "success",
                    ["active"] = active,
                    ["stop_file"] = BotRegistry.StopPath,
                });
                return;
            }

            if (path == "/api/quotas" && method == "GET")
            {
                var box = new RelayBox();
                await ReplyAsync(stream, 200, new JsonObject
                {
                    ["status"] = "success",
                    ["codex"] = AppSessions.CodexUsage()?.DeepClone(),
                    ["codex_blocked_reason"] = AppSessions.CodexQuota(),
                    ["antigravity"] = AppSessions.AntigravityUsage(box)?.DeepClone(),
                    ["antigravity_blocked_reason"] = AppSessions.AntigravityQuota(box),
                });
                return;
            }

            if (path == "/api/engine" && method == "GET")
            {
                await ReplyAsync(stream, 200, new JsonObject
                {
                    ["status"] = "success",
                    ["service"] = "nexus-bot-studio-engine",
                    ["version"] = RelayPaths.Version,
                    ["pid"] = Environment.ProcessId,
                    ["relay_home"] = RelayPaths.RelayHome(),
                    ["bots"] = BotRegistry.List().Count,
                    ["sse_clients"] = BotEvents.SubscriberCount,
                    ["emergency_stop"] = BotRegistry.EmergencyStopActive(),
                    ["max_hops"] = BotRegistry.MaxHops(),
                    ["spawn_enabled"] = BotRegistry.SpawnEnabled(),
                });
                return;
            }

            if (path == "/api/engine/config" && method == "POST")
            {
                int? maxHops = request["max_hops"] is JsonValue mh && mh.TryGetValue<int>(out int parsedHops)
                    ? Math.Clamp(parsedHops, 1, 100)
                    : null;
                bool? spawnEnabled = request["spawn_enabled"] is JsonValue se && se.TryGetValue<bool>(out bool parsedSpawn)
                    ? parsedSpawn
                    : null;
                BotRegistry.SetConfig(maxHops, spawnEnabled);
                await ReplyAsync(stream, 200, new JsonObject
                {
                    ["status"] = "success",
                    ["max_hops"] = BotRegistry.MaxHops(),
                    ["spawn_enabled"] = BotRegistry.SpawnEnabled(),
                });
                return;
            }

            await ReplyAsync(stream, 404, new JsonObject { ["status"] = "error", ["error"] = "unknown control route" });
        }
        catch (RelayError e)
        {
            await ReplyAsync(stream, 400, new JsonObject { ["status"] = "error", ["error"] = e.Message });
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
        {
            await ReplyAsync(stream, 500, new JsonObject { ["status"] = "error", ["error"] = e.Message });
        }
    }

    private static async Task PostUserMessageAsync(NetworkStream stream, JsonObject request)
    {
        var to = request["to"]?.ToString() ?? "";
        if (!BotRegistry.IsRegistered(to))
            throw new RelayError($"unknown recipient bot_id: {to}");
        var text = request["text"]?.ToString() ?? "";
        if (string.IsNullOrWhiteSpace(text)) throw new RelayError("text is required");
        var topic = request["topic"]?.ToString() ?? "default";
        var extra = new JsonObject
        {
            ["source"] = "user-ui",
            ["trace_id"] = request["trace_id"]?.ToString() ?? BotRegistry.NewTraceId(),
            ["hop_count"] = 0,
        };
        if (request["attachments"] is JsonArray attachments) extra["attachments"] = attachments.DeepClone();

        var box = new RelayBox();
        var message = box.Post(RelayPaths.User, to, text, topic, extra: extra);
        McpServer.Runtime?.Ring(message);
        var payload = message.ToJson();
        payload["from_kind"] = "user";
        BotEvents.Publish("message_posted", payload);
        await ReplyAsync(stream, 200, new JsonObject
        {
            ["status"] = "success",
            ["id"] = message.Id,
            ["to"] = message.To,
            ["topic"] = message.Topic,
            ["trace_id"] = extra["trace_id"]?.DeepClone(),
        });
    }

    private static async Task EventsAsync(NetworkStream stream, CancellationToken token)
    {
        const string header = "HTTP/1.1 200 OK\r\n" +
            "Content-Type: text/event-stream\r\n" +
            "Cache-Control: no-cache\r\n" +
            "Connection: keep-alive\r\n" +
            "X-Accel-Buffering: no\r\n\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(header).AsMemory(), token);
        await stream.FlushAsync(token);

        using var subscription = BotEvents.Subscribe();
        BotEvents.Publish("sse_connected", new JsonObject { ["clients"] = BotEvents.SubscriberCount });
        while (!token.IsCancellationRequested)
        {
            JsonObject? ev;
            try
            {
                ev = await subscription.NextAsync(TimeSpan.FromSeconds(15), token);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            string frame = ev is null
                ? ": heartbeat\n\n"
                : $"event: {ev["type"]?.ToString() ?? "message"}\nid: {ev["seq"]?.ToString() ?? "0"}\ndata: {ev.ToJsonString()}\n\n";
            try
            {
                await stream.WriteAsync(Encoding.UTF8.GetBytes(frame).AsMemory(), token);
                await stream.FlushAsync(token);
            }
            catch (IOException)
            {
                break;
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }
}

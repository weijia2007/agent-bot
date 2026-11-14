using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;

namespace NexusRelay.Tests;

/// <summary>
/// NexusBot Studio engine extension: dynamic bot identities, as_bot routing, hop guard,
/// the SSE event stream and the loopback control API. All tests use their own isolated
/// NEXUS_RELAY_HOME so the real user mailbox and the original daemon are never touched.
/// </summary>
public sealed class BotStudioTests : IDisposable
{
    private readonly Isolation iso = new();
    public void Dispose() => iso.Dispose();

    private static JsonObject Spec(string id, string engine, string room = "studio", bool supervisor = false)
        => new()
        {
            ["bot_id"] = id,
            ["display_name"] = id,
            ["engine_type"] = engine,
            ["role"] = supervisor ? "supervisor" : "worker",
            ["room"] = room,
            ["is_supervisor"] = supervisor,
            ["workspace"] = "",
        };

    [Fact]
    public void Dynamic_bot_ids_register_and_keep_independent_conversations()
    {
        BotRegistry.Register(Spec("supervisor-1", "claude", supervisor: true));
        BotRegistry.Register(Spec("fe-claude-1", "claude"));
        BotRegistry.Register(Spec("be-codex-1", "codex"));

        Assert.True(BotRegistry.IsRegistered("fe-claude-1"));
        Assert.True(BotRegistry.IsRegistered("be-codex-1"));
        // A registered dynamic id stays itself: collapsing it back to "claude" would merge every
        // Claude bot into one shared inbox/conversation, which is exactly what Studio forbids.
        Assert.Equal("fe-claude-1", RelayPaths.NormalizeAgent("fe-claude-1"));
        Assert.Equal("be-codex-1", RelayPaths.NormalizeAgent("be-codex-1"));
        // Legacy aliases still normalise, so the original three-party protocol keeps working.
        Assert.Equal("claude", RelayPaths.NormalizeAgent("claude"));
        Assert.Equal("codex", BotRegistry.EngineOf("be-codex-1"));
        Assert.False(BotRegistry.IsRegistered("not.registered"));

        // A real send -> read -> reply round trip between two dynamic bots, through the message box.
        var sent = McpServer.CallToolPayload("send", new JsonObject
        {
            ["to"] = "be-codex-1",
            ["text"] = "Build the /health endpoint",
            ["topic"] = "studio",
        }, "supervisor-1");
        Assert.Equal("success", sent["status"]?.ToString());
        string id = sent["id"]!.ToString();

        var inbox = McpServer.CallToolPayload("inbox", new JsonObject(), "be-codex-1");
        Assert.Contains(id, inbox["unread"]!.AsArray().Select(n => n?["id"]?.ToString() ?? ""));

        var read = McpServer.CallToolPayload("read", new JsonObject { ["id"] = id }, "be-codex-1");
        Assert.Equal("supervisor-1", read["message"]?["from"]?.ToString());
        Assert.False(string.IsNullOrWhiteSpace(iso.Box().Get(id)!.ExtraObj["trace_id"]?.ToString()));

        var reply = McpServer.CallToolPayload("reply", new JsonObject { ["id"] = id, ["text"] = "Done: Health.cs:12" }, "be-codex-1");
        Assert.Equal("success", reply["status"]?.ToString());

        // The other Claude bot has its own inbox: no cross-talk between sessions.
        var other = McpServer.CallToolPayload("inbox", new JsonObject(), "fe-claude-1");
        Assert.DoesNotContain(id, other["unread"]!.AsArray().Select(n => n?["id"]?.ToString() ?? ""));
    }

    [Fact]
    public void As_bot_only_accepts_a_registered_identity_on_the_same_engine()
    {
        BotRegistry.Register(Spec("agy-a", "antigravity"));
        BotRegistry.Register(Spec("agy-b", "antigravity"));
        BotRegistry.Register(Spec("claude-a", "claude"));

        var ok = McpServer.CallToolPayload("inbox", new JsonObject { ["as_bot"] = "agy-a" }, "antigravity");
        Assert.Equal("success", ok["status"]?.ToString());

        var cross = McpServer.CallToolPayload("inbox", new JsonObject { ["as_bot"] = "claude-a" }, "antigravity");
        Assert.Equal("error", cross["status"]?.ToString());
        Assert.Contains("not antigravity", cross["error"]?.ToString() ?? "");

        var unknown = McpServer.CallToolPayload("inbox", new JsonObject { ["as_bot"] = "ghost-1" }, "antigravity");
        Assert.Equal("error", unknown["status"]?.ToString());
        Assert.Contains("not a registered bot", unknown["error"]?.ToString() ?? "");
    }

    [Fact]
    public void List_bots_and_spawn_bot_are_real_tools_and_spawn_emits_an_sse_request()
    {
        BotRegistry.Register(Spec("qa-agy-1", "antigravity"));
        var list = McpServer.CallToolPayload("list_bots", new JsonObject { ["room"] = "studio" }, "claude");
        Assert.Equal("success", list["status"]?.ToString());
        var names = list["bots"]!.AsArray().Select(b => b?["bot_id"]?.ToString()).ToArray();
        Assert.Contains("qa-agy-1", names);
        Assert.DoesNotContain("claude", names); // room filter excludes the legacy aliases

        iso.Set("NEXUS_BOT_SPAWN_ENABLED", "1");
        using var subscription = BotEvents.Subscribe();
        var spawn = McpServer.CallToolPayload("spawn_bot", new JsonObject
        {
            ["engine_type"] = "codex",
            ["display_name"] = "DB engineer",
            ["role"] = "backend",
            ["workspace_mode"] = "worktree",
            ["room"] = "studio",
        }, "claude");
        Assert.Equal("success", spawn["status"]?.ToString());
        Assert.StartsWith("spawn-", spawn["request_id"]?.ToString() ?? "");

        var ev = subscription.NextAsync(TimeSpan.FromSeconds(2), TestContext.Current.CancellationToken).GetAwaiter().GetResult();
        Assert.NotNull(ev);
        Assert.Equal("spawn_bot_request", ev!["type"]?.ToString());
        Assert.Equal("codex", ev["data"]?["engine_type"]?.ToString());
        Assert.Equal("claude", ev["data"]?["requested_by"]?.ToString());

        iso.Set("NEXUS_BOT_SPAWN_ENABLED", null);
        var disabled = McpServer.CallToolPayload("spawn_bot", new JsonObject
        {
            ["engine_type"] = "codex", ["display_name"] = "no",
        }, "claude");
        Assert.Equal("error", disabled["status"]?.ToString());
    }

    [Fact]
    public void Hop_count_increments_and_pauses_automatic_wake_at_the_limit()
    {
        BotRegistry.Register(Spec("supervisor-1", "claude", supervisor: true));
        iso.Set("NEXUS_BOT_MAX_HOPS", "2");
        using var subscription = BotEvents.Subscribe();

        var sent = McpServer.CallToolPayload("send", new JsonObject
        {
            ["to"] = "codex",
            ["text"] = "chain step 2",
            ["topic"] = "studio",
            ["trace_id"] = "trace-abc",
            ["hop_count"] = 1,
        }, "supervisor-1");
        Assert.Equal("success", sent["status"]?.ToString());
        string id = sent["id"]!.ToString();

        McpServer.CallToolPayload("read", new JsonObject { ["id"] = id }, "codex");
        var stored = iso.Box().Get(id)!.ExtraObj;
        Assert.Equal("trace-abc", stored["trace_id"]?.ToString());
        Assert.Equal(2, stored["hop_count"]?.GetValue<int>());
        Assert.True(stored["paused"]?.GetValue<bool>());

        var pausedEvent = subscription.NextAsync(TimeSpan.FromSeconds(2), TestContext.Current.CancellationToken).GetAwaiter().GetResult();
        Assert.Equal("max_hops_reached", pausedEvent?["type"]?.ToString());
        Assert.Equal(2, pausedEvent?["data"]?["hop_count"]?.GetValue<int>());
    }

    [Fact]
    public void Emergency_stop_flag_lives_in_the_isolated_home()
    {
        Assert.False(BotRegistry.EmergencyStopActive());
        BotRegistry.SetEmergencyStop(true);
        Assert.True(BotRegistry.EmergencyStopActive());
        Assert.True(File.Exists(BotRegistry.StopPath));
        Assert.StartsWith(iso.Relay, BotRegistry.StopPath);
        BotRegistry.SetEmergencyStop(false);
        Assert.False(BotRegistry.EmergencyStopActive());
    }

    [Fact]
    public void Http_control_api_is_token_protected_and_streams_real_events()
    {
        using var daemon = new Daemon(fixture: true);
        using var client = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Daemon.Token);
        string root = $"http://127.0.0.1:{daemon.Port}";

        // No token: 401 on every control route.
        using (var bare = new HttpClient())
        using (var denied = bare.GetAsync($"{root}/api/bots", TestContext.Current.CancellationToken).GetAwaiter().GetResult())
            Assert.Equal(HttpStatusCode.Unauthorized, denied.StatusCode);

        JsonNode Get(string path)
            => JsonNode.Parse(client.GetStringAsync(root + path, TestContext.Current.CancellationToken).GetAwaiter().GetResult())!;

        JsonNode Post(string path, JsonObject body)
        {
            using var content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
            using var response = client.PostAsync(root + path, content, TestContext.Current.CancellationToken).GetAwaiter().GetResult();
            Assert.True(response.IsSuccessStatusCode, response.StatusCode.ToString());
            return JsonNode.Parse(response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken).GetAwaiter().GetResult())!;
        }

        var engine = Get("/api/engine");
        Assert.Equal("success", engine["status"]?.ToString());
        Assert.Equal("nexus-bot-studio-engine", engine["service"]?.ToString());
        Assert.Equal(10, engine["max_hops"]?.GetValue<int>());

        var registered = Post("/api/bots/register", Spec("fe-claude-1", "claude"));
        Assert.Equal("success", registered["status"]?.ToString());
        var bots = Get("/api/bots");
        Assert.Contains("fe-claude-1", (bots["bots"] as JsonArray)!.Select(b => b?["bot_id"]?.ToString()));
        Assert.Equal("claude", Get("/api/bots")["bots"]!.AsArray().First(b => b?["bot_id"]?.ToString() == "fe-claude-1")?["engine_type"]?.ToString());

        // SSE: open the stream first, wait until the daemon reports a subscriber, then post a message.
        using var sseCts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var events = Task.Run(async () =>
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, root + "/api/events");
            request.Headers.Accept.ParseAdd("text/event-stream");
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, sseCts.Token);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(sseCts.Token), Encoding.UTF8);
            var frames = new List<string>();
            while (!sseCts.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync(sseCts.Token);
                if (line is null) break;
                if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;
                frames.Add(line[5..].Trim());
                if (line.Contains("message_posted", StringComparison.Ordinal)) break;
            }
            return frames;
        }, sseCts.Token);

        Wait.Until(() => Get("/api/engine")["sse_clients"]?.GetValue<int>() > 0, 8, "SSE subscriber");
        var posted = Post("/api/messages/user", new JsonObject
        {
            ["to"] = "fe-claude-1",
            ["text"] = "Please review the login flow",
            ["topic"] = "studio",
        });
        Assert.Equal("success", posted["status"]?.ToString());
        Assert.Equal("fe-claude-1", posted["to"]?.ToString());

        var frames = events.GetAwaiter().GetResult();
        Assert.Contains(frames, f => f.Contains("message_posted") && f.Contains("Please review the login flow"));
        sseCts.Cancel();

        var stop = Post("/api/emergency-stop", new JsonObject());
        Assert.True(stop["active"]?.GetValue<bool>());
        using (var delete = new HttpRequestMessage(HttpMethod.Delete, root + "/api/emergency-stop"))
        using (var response = client.SendAsync(delete, TestContext.Current.CancellationToken).GetAwaiter().GetResult())
            Assert.True(response.IsSuccessStatusCode);

        var quotas = Get("/api/quotas");
        Assert.Equal("success", quotas["status"]?.ToString());
        Assert.True(quotas.AsObject().ContainsKey("codex"));
        Assert.True(quotas.AsObject().ContainsKey("antigravity"));

        var updatedCfg = Post("/api/engine/config", new JsonObject
        {
            ["max_hops"] = 4,
            ["spawn_enabled"] = true,
        });
        Assert.Equal("success", updatedCfg["status"]?.ToString());
        Assert.Equal(4, updatedCfg["max_hops"]?.GetValue<int>());
        Assert.True(updatedCfg["spawn_enabled"]?.GetValue<bool>());
        var refreshedEngine = Get("/api/engine");
        Assert.Equal(4, refreshedEngine["max_hops"]?.GetValue<int>());
        Assert.True(refreshedEngine["spawn_enabled"]?.GetValue<bool>());

        var search = Get("/api/search?q=login+flow&topic=studio");
        Assert.Equal("fts5", search["engine"]?.ToString());
        Assert.True(search["total"]?.GetValue<int>() >= 1);

        var messages = Get("/api/messages?topic=studio");
        Assert.Equal("success", messages["status"]?.ToString());
        Assert.Contains("Please review the login flow", messages["messages"]!.ToJsonString());

        // Create and delete an EditGuard lock through MCP reserve -> /api/locks -> DELETE /api/locks/{id}
        var targetFile = Path.Join(iso.Root, "src", "login.ts");
        var reserveReq = new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = 99,
            ["method"] = "tools/call",
            ["params"] = new JsonObject
            {
                ["name"] = "reserve",
                ["arguments"] = new JsonObject
                {
                    ["paths"] = new JsonArray(targetFile),
                    ["reason"] = "editing auth",
                },
            },
        };
        using (var mcpContent = new StringContent(reserveReq.ToJsonString(), Encoding.UTF8, "application/json"))
        using (var mcpRes = client.PostAsync(root + "/mcp?bot=fe-claude-1", mcpContent, TestContext.Current.CancellationToken).GetAwaiter().GetResult())
        {
            Assert.True(mcpRes.IsSuccessStatusCode);
            var mcpBody = mcpRes.Content.ReadAsStringAsync(TestContext.Current.CancellationToken).GetAwaiter().GetResult();
            Assert.Contains("fe-claude-1", mcpBody, StringComparison.Ordinal);
            Assert.Contains("success", mcpBody, StringComparison.Ordinal);
        }

        var locks = Get("/api/locks");
        var lockId = locks["locks"]!.AsArray().First(l => l?["agent"]?.ToString() == "fe-claude-1")!["id"]!.ToString();
        using (var delLock = new HttpRequestMessage(HttpMethod.Delete, root + $"/api/locks/{lockId}"))
        using (var delResp = client.SendAsync(delLock, TestContext.Current.CancellationToken).GetAwaiter().GetResult())
            Assert.True(delResp.IsSuccessStatusCode);
        Assert.Empty(Get("/api/locks")["locks"]!.AsArray());
    }

    [Fact]
    public void Fts5_indexes_cjk_latin_and_diacritics_and_syncs_existing_messages()
    {
        var box = new RelayBox();
        box.Post("claude", "codex", "实现用户登录模块并支持 café diacritics", "fts-room");
        var dbPath = RelayFtsIndex.DbPath(box);
        Assert.True(File.Exists(dbPath));

        var cjkHits = SearchAndSummary.Search(box, "登录", topic: "fts-room");
        Assert.Single(cjkHits);
        Assert.Contains("实现用户登录模块", cjkHits[0].Message.Text);

        var cafeHits = SearchAndSummary.Search(box, "cafe diacritics", topic: "fts-room");
        Assert.Single(cafeHits);

        // Delete FTS5 database and confirm automatic lazy backfill restores all queries.
        File.Delete(dbPath);
        Assert.Single(SearchAndSummary.Search(box, "模块", topic: "fts-room"));
        Assert.True(File.Exists(dbPath));
    }

    [Fact]
    public void Dynamic_bot_review_does_not_widen_to_legacy_and_supports_more_than_three_waits()
    {
        foreach (var (id, eng) in new[]
        {
            ("bot-a1", "claude"), ("bot-b2", "codex"), ("bot-c3", "antigravity"), ("bot-d4", "claude"), ("bot-e5", "codex"),
        })
            BotRegistry.Register(Spec(id, eng));

        var reviewSent = McpServer.CallToolPayload("send", new()
        {
            ["to"] = "bot-b2",
            ["text"] = "Please review login.ts for regressions",
            ["topic"] = "multi-bot",
            ["review"] = true,
        }, "bot-a1");
        Assert.Equal("success", reviewSent["status"]?.ToString());
        Assert.Equal("bot-b2", reviewSent["to"]?.ToString());
        Assert.Null(reviewSent["ids"]);

        // Fan-out across 4 recipients and wait for all 4 replies in one call.
        var multiSent = McpServer.CallToolPayload("send", new()
        {
            ["to"] = new JsonArray("bot-b2", "bot-c3", "bot-d4", "bot-e5"),
            ["text"] = "Report module readiness",
            ["topic"] = "multi-bot",
            ["trace_id"] = "trace-multi",
            ["hop_count"] = 2,
        }, "bot-a1");
        var ids = multiSent["ids"]!.AsArray().Select(n => n!.ToString()).ToArray();
        Assert.Equal(4, ids.Length);

        // Capturing SSE events verifies ToolReply publishes message_posted with incremented hop_count.
        string[] responders = ["bot-b2", "bot-c3", "bot-d4", "bot-e5"];
        var events = new List<JsonObject>();
        using (var sub = BotEvents.Subscribe())
        {
            foreach (var (rid, responder) in ids.Zip(responders))
            {
                var rep = McpServer.CallToolPayload("reply", new() { ["id"] = rid, ["text"] = $"Ready from {responder}" }, responder);
                Assert.Equal("success", rep["status"]?.ToString());
            }
            while (sub.NextAsync(TimeSpan.FromMilliseconds(50), TestContext.Current.CancellationToken).GetAwaiter().GetResult() is JsonObject ev)
                events.Add(ev);
        }

        var posted = events.Where(e => e["type"]?.ToString() == "message_posted").Select(e => e["data"]!.AsObject()).ToList();
        Assert.Equal(4, posted.Count);
        Assert.All(posted, p => Assert.Equal("trace-multi", p["extra"]?["trace_id"]?.ToString()));
        Assert.All(posted, p => Assert.Equal(4, p["extra"]?["hop_count"]?.GetValue<int>()));

        var waited = McpServer.CallToolPayload("wait_reply", new() { ["id"] = new JsonArray(ids.Select(i => (JsonNode)i).ToArray()), ["timeout_s"] = 1 }, "bot-a1");
        Assert.Equal("success", waited["status"]?.ToString());
        Assert.Equal(4, waited["answered"]?.GetValue<int>());
    }
}

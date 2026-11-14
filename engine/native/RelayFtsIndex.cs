using System.Globalization;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

namespace NexusRelay;

/// <summary>
/// Per-relay-home SQLite FTS5 message index backed by Windows' built-in winsqlite3.dll.
/// Stored at <c>&lt;RelayHome&gt;/v1/search-fts5.db</c> and kept synchronized lazily and on Post().
/// </summary>
public static partial class RelayFtsIndex
{
    private const int SqliteOpenReadWrite = 0x00000002;
    private const int SqliteOpenCreate = 0x00000004;
    private const int SqliteOk = 0;
    private const int SqliteRow = 100;
    private const int SqliteDone = 101;
    private static readonly nint SqliteTransient = new(-1);
    private static readonly Lock IndexLock = new();

    [LibraryImport("winsqlite3.dll", EntryPoint = "sqlite3_open_v2", StringMarshalling = StringMarshalling.Utf8)]
    [UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    private static partial int SqliteOpenV2(string filename, out nint db, int flags, nint vfs);

    [LibraryImport("winsqlite3.dll", EntryPoint = "sqlite3_close_v2")]
    [UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    private static partial int SqliteCloseV2(nint db);

    [LibraryImport("winsqlite3.dll", EntryPoint = "sqlite3_busy_timeout")]
    [UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    private static partial int SqliteBusyTimeout(nint db, int ms);

    [LibraryImport("winsqlite3.dll", EntryPoint = "sqlite3_exec", StringMarshalling = StringMarshalling.Utf8)]
    [UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    private static partial int SqliteExec(nint db, string sql, nint callback, nint arg, nint errMsg);

    [LibraryImport("winsqlite3.dll", EntryPoint = "sqlite3_prepare_v2", StringMarshalling = StringMarshalling.Utf8)]
    [UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    private static partial int SqlitePrepareV2(nint db, string sql, int nByte, out nint stmt, nint tail);

    [LibraryImport("winsqlite3.dll", EntryPoint = "sqlite3_bind_text", StringMarshalling = StringMarshalling.Utf8)]
    [UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    private static partial int SqliteBindText(nint stmt, int idx, string value, int byteLen, nint destructor);

    [LibraryImport("winsqlite3.dll", EntryPoint = "sqlite3_step")]
    [UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    private static partial int SqliteStep(nint stmt);

    [LibraryImport("winsqlite3.dll", EntryPoint = "sqlite3_finalize")]
    [UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    private static partial int SqliteFinalize(nint stmt);

    [LibraryImport("winsqlite3.dll", EntryPoint = "sqlite3_column_text")]
    [UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    private static partial nint SqliteColumnText(nint stmt, int col);

    [LibraryImport("winsqlite3.dll", EntryPoint = "sqlite3_errmsg")]
    [UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    private static partial nint SqliteErrMsg(nint db);

    public static string DbPath(RelayBox box) => Path.Join(box.Root, "search-fts5.db");

    private static string Err(nint db) => Marshal.PtrToStringUTF8(SqliteErrMsg(db)) ?? "sqlite error";

    private static bool IsCjk(Rune r)
    {
        int cp = r.Value;
        return cp is (>= 0x4E00 and <= 0x9FFF)
            or (>= 0x3400 and <= 0x4DBF)
            or (>= 0xF900 and <= 0xFAFF)
            or (>= 0x3040 and <= 0x30FF)
            or (>= 0xAC00 and <= 0xD7AF);
    }

    /// <summary>
    /// Expands folded text with per-character / bigram CJK tokens so FTS5 unicode61 indexes
    /// Chinese/Japanese/Korean substrings seamlessly alongside Latin prefix tokens.
    /// </summary>
    internal static string PrepareFtsDocument(string text)
    {
        var folded = SearchAndSummary.Bare(text);
        var sb = new StringBuilder(folded.Length + 64);
        sb.Append(folded);

        var cjkRun = new List<Rune>();
        void FlushRun()
        {
            if (cjkRun.Count == 0) return;
            sb.Append(' ');
            for (int i = 0; i < cjkRun.Count; i++)
            {
                sb.Append(cjkRun[i].ToString());
                sb.Append(' ');
                if (i + 1 < cjkRun.Count)
                {
                    sb.Append(cjkRun[i].ToString());
                    sb.Append(cjkRun[i + 1].ToString());
                    sb.Append(' ');
                }
            }
            cjkRun.Clear();
        }

        foreach (var rune in folded.EnumerateRunes())
        {
            if (IsCjk(rune)) cjkRun.Add(rune);
            else FlushRun();
        }
        FlushRun();
        return sb.ToString();
    }

    private static nint OpenAndInit(RelayBox box)
    {
        var path = DbPath(box);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        int rc = SqliteOpenV2(path, out nint db, SqliteOpenReadWrite | SqliteOpenCreate, nint.Zero);
        if (rc != SqliteOk)
        {
            var err = db != nint.Zero ? Err(db) : $"sqlite3_open_v2 failed ({rc})";
            if (db != nint.Zero) _ = SqliteCloseV2(db);
            throw new IOException(err);
        }
        try
        {
            _ = SqliteBusyTimeout(db, 5000);
            ExecSql(db, """
                PRAGMA journal_mode=WAL;
                PRAGMA synchronous=NORMAL;
                CREATE TABLE IF NOT EXISTS messages_meta (
                    id TEXT PRIMARY KEY,
                    sender TEXT NOT NULL,
                    recipient TEXT NOT NULL,
                    topic TEXT NOT NULL,
                    created TEXT NOT NULL
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                    id UNINDEXED,
                    sender,
                    recipient,
                    topic,
                    folded_text,
                    tokenize = 'unicode61 remove_diacritics 2'
                );
                """);
            return db;
        }
        catch
        {
            _ = SqliteCloseV2(db);
            throw;
        }
    }

    private static void ExecSql(nint db, string sql)
    {
        if (SqliteExec(db, sql, nint.Zero, nint.Zero, nint.Zero) != SqliteOk)
            throw new IOException(Err(db));
    }

    private static void UpsertRow(nint db, RelayMessage msg)
    {
        var ftsText = PrepareFtsDocument(msg.Text);
        if (SqlitePrepareV2(db, "SELECT 1 FROM messages_meta WHERE id = ?1", -1, out nint checkStmt, nint.Zero) == SqliteOk)
        {
            try
            {
                _ = SqliteBindText(checkStmt, 1, msg.Id, -1, SqliteTransient);
                if (SqliteStep(checkStmt) == SqliteRow) return;
            }
            finally { _ = SqliteFinalize(checkStmt); }
        }

        if (SqlitePrepareV2(db,
            "INSERT OR IGNORE INTO messages_meta(id, sender, recipient, topic, created) VALUES (?1, ?2, ?3, ?4, ?5)",
            -1, out nint metaStmt, nint.Zero) != SqliteOk)
            throw new IOException(Err(db));
        try
        {
            _ = SqliteBindText(metaStmt, 1, msg.Id, -1, SqliteTransient);
            _ = SqliteBindText(metaStmt, 2, msg.Sender, -1, SqliteTransient);
            _ = SqliteBindText(metaStmt, 3, msg.To, -1, SqliteTransient);
            _ = SqliteBindText(metaStmt, 4, msg.Topic, -1, SqliteTransient);
            _ = SqliteBindText(metaStmt, 5, msg.Created, -1, SqliteTransient);
            int step = SqliteStep(metaStmt);
            if (step != SqliteDone) throw new IOException(Err(db));
        }
        finally { _ = SqliteFinalize(metaStmt); }

        if (SqlitePrepareV2(db,
            "INSERT INTO messages_fts(id, sender, recipient, topic, folded_text) VALUES (?1, ?2, ?3, ?4, ?5)",
            -1, out nint ftsStmt, nint.Zero) != SqliteOk)
            throw new IOException(Err(db));
        try
        {
            _ = SqliteBindText(ftsStmt, 1, msg.Id, -1, SqliteTransient);
            _ = SqliteBindText(ftsStmt, 2, msg.Sender, -1, SqliteTransient);
            _ = SqliteBindText(ftsStmt, 3, msg.To, -1, SqliteTransient);
            _ = SqliteBindText(ftsStmt, 4, msg.Topic, -1, SqliteTransient);
            _ = SqliteBindText(ftsStmt, 5, ftsText, -1, SqliteTransient);
            int step = SqliteStep(ftsStmt);
            if (step != SqliteDone) throw new IOException(Err(db));
        }
        finally { _ = SqliteFinalize(ftsStmt); }
    }

    public static void IndexMessage(RelayBox box, RelayMessage msg)
    {
        lock (IndexLock)
        {
            try
            {
                nint db = OpenAndInit(box);
                try
                {
                    ExecSql(db, "BEGIN IMMEDIATE;");
                    UpsertRow(db, msg);
                    ExecSql(db, "COMMIT;");
                }
                catch
                {
                    try { ExecSql(db, "ROLLBACK;"); } catch { /* ignore */ }
                    throw;
                }
                finally { _ = SqliteCloseV2(db); }
            }
            catch (Exception e) when (e is IOException or DllNotFoundException or EntryPointNotFoundException)
            {
                Console.Error.WriteLine($"RelayFtsIndex.IndexMessage: {e.Message}");
            }
        }
    }

    private static int SyncAllLocked(nint db, RelayBox box)
    {
        var known = new HashSet<string>(StringComparer.Ordinal);
        if (SqlitePrepareV2(db, "SELECT id FROM messages_meta", -1, out nint stmt, nint.Zero) == SqliteOk)
        {
            try
            {
                while (SqliteStep(stmt) == SqliteRow)
                {
                    var id = Marshal.PtrToStringUTF8(SqliteColumnText(stmt, 0));
                    if (!string.IsNullOrEmpty(id)) known.Add(id);
                }
            }
            finally { _ = SqliteFinalize(stmt); }
        }

        var all = box.All();
        var missing = all.Where(m => !known.Contains(m.Id)).ToList();
        if (missing.Count == 0) return known.Count;

        ExecSql(db, "BEGIN IMMEDIATE;");
        try
        {
            foreach (var m in missing) UpsertRow(db, m);
            ExecSql(db, "COMMIT;");
        }
        catch
        {
            try { ExecSql(db, "ROLLBACK;"); } catch { /* ignore */ }
            throw;
        }
        return known.Count + missing.Count;
    }

    public static int SyncAll(RelayBox box)
    {
        lock (IndexLock)
        {
            nint db = OpenAndInit(box);
            try { return SyncAllLocked(db, box); }
            finally { _ = SqliteCloseV2(db); }
        }
    }

    /// <summary>
    /// Builds a strict FTS5 expression from folded search terms, supporting Latin prefix tokens and
    /// CJK unigram/bigram decomposition. Returns null if any term relies on symbols/delimiters.
    /// </summary>
    public static string? BuildMatchExpression(IReadOnlyList<string> foldedTerms)
    {
        if (foldedTerms.Count == 0) return null;
        var parts = new List<string>(foldedTerms.Count);
        foreach (var term in foldedTerms)
        {
            if (string.IsNullOrWhiteSpace(term)) continue;
            var runes = term.EnumerateRunes().ToList();
            if (runes.Any(r => !Rune.IsLetterOrDigit(r)))
                return null;

            if (runes.All(IsCjk))
            {
                if (runes.Count == 1)
                {
                    parts.Add($"\"{runes[0]}\"");
                }
                else
                {
                    for (int i = 0; i + 1 < runes.Count; i++)
                        parts.Add($"\"{runes[i]}{runes[i + 1]}\"");
                }
            }
            else if (runes.Any(IsCjk))
            {
                // Mixed Latin + CJK single word without whitespace: let in-memory fallback preserve exact substring semantics.
                return null;
            }
            else
            {
                var escaped = term.Replace("\"", "\"\"", StringComparison.Ordinal);
                parts.Add($"\"{escaped}\"*");
            }
        }
        return parts.Count > 0 ? string.Join(" AND ", parts) : null;
    }

    /// <summary>
    /// Queries candidate message IDs ordered by FTS5 BM25 relevance. Returns null when FTS5 cannot
    /// cleanly represent a symbol/mixed query so the caller falls back to full scan.
    /// </summary>
    public static List<string>? QueryCandidateIds(RelayBox box, IReadOnlyList<string> foldedTerms, string? topic, string? sender)
    {
        var matchExpr = BuildMatchExpression(foldedTerms);
        if (matchExpr is null) return null;

        lock (IndexLock)
        {
            try
            {
                nint db = OpenAndInit(box);
                try
                {
                    _ = SyncAllLocked(db, box);
                    var sql = new StringBuilder("SELECT m.id FROM messages_fts f JOIN messages_meta m ON m.id = f.id WHERE f.folded_text MATCH ?1");
                    int nextParam = 2;
                    int topicParam = 0, senderParam = 0;
                    if (!string.IsNullOrEmpty(topic))
                    {
                        topicParam = nextParam++;
                        sql.Append(CultureInfo.InvariantCulture, $" AND m.topic = ?{topicParam}");
                    }
                    if (!string.IsNullOrEmpty(sender))
                    {
                        senderParam = nextParam++;
                        sql.Append(CultureInfo.InvariantCulture, $" AND m.sender = ?{senderParam}");
                    }
                    sql.Append(" ORDER BY bm25(messages_fts) ASC, m.id DESC");

                    if (SqlitePrepareV2(db, sql.ToString(), -1, out nint stmt, nint.Zero) != SqliteOk)
                        return null;
                    try
                    {
                        _ = SqliteBindText(stmt, 1, matchExpr, -1, SqliteTransient);
                        if (topicParam > 0) _ = SqliteBindText(stmt, topicParam, topic!, -1, SqliteTransient);
                        if (senderParam > 0) _ = SqliteBindText(stmt, senderParam, RelayPaths.NormalizeParty(sender!), -1, SqliteTransient);

                        var ids = new List<string>();
                        while (SqliteStep(stmt) == SqliteRow)
                        {
                            var id = Marshal.PtrToStringUTF8(SqliteColumnText(stmt, 0));
                            if (!string.IsNullOrEmpty(id)) ids.Add(id);
                        }
                        return ids;
                    }
                    finally { _ = SqliteFinalize(stmt); }
                }
                finally { _ = SqliteCloseV2(db); }
            }
            catch (Exception e) when (e is IOException or DllNotFoundException or EntryPointNotFoundException)
            {
                Console.Error.WriteLine($"RelayFtsIndex.QueryCandidateIds: {e.Message}");
                return null;
            }
        }
    }
}

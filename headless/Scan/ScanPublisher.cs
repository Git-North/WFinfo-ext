using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using WFInfo.Errors;

namespace WFInfo.Scan
{
    /// <summary>
    /// Publishes scan records in a scans folder: latest.json, last.png and one
    /// scan-&lt;stamp&gt;.json per record (newest 60 kept).
    ///
    /// The screenshot and the record are one pair. Both are first written
    /// completely under per-process temporary names in the folder, then renamed
    /// into place, the screenshot first and the record last. A scan killed
    /// before the renames leaves the previous pair untouched (only .tmp files,
    /// which a later run deletes), and latest.json is never seen half-written.
    ///
    /// Keep-last-good rule: a record without choices (nothing found, or a
    /// failure) does not replace a previous record that has choices. The
    /// previous record stays with a <see cref="ScanResult.Notice"/> ("Last scan
    /// found nothing at 14:32"), last.png stays too, and only the record file
    /// changes. The empty or failed record still goes into the history.
    /// </summary>
    internal sealed class ScanPublisher
    {
        /// <summary>Record files kept next to latest.json (mirrors the OCR-suite retention).</summary>
        public const int RetentionFiles = 60;

        /// <summary>Catalog code of a scan that captured but recognised no reward name.</summary>
        public const string NothingFoundCode = "SCN-001";

        private readonly int _processId;

        public ScanPublisher(string scansDir)
            : this(scansDir, Environment.ProcessId)
        {
        }

        public ScanPublisher(string scansDir, int processId)
        {
            ScansDir = scansDir;
            _processId = processId;
        }

        public string ScansDir { get; }

        public string LatestPath => Path.Combine(ScansDir, "latest.json");

        public string ScreenshotPath => Path.Combine(ScansDir, "last.png");

        /// <summary>
        /// This run's screenshot before it is published: inside the scans
        /// folder (never $TMPDIR), named per process, so a killed scan leaves
        /// only this file.
        /// </summary>
        public string PendingScreenshot =>
            Path.Combine(ScansDir, "last.png." + _processId.ToString(CultureInfo.InvariantCulture) + ".tmp");

        public string PendingRecord =>
            Path.Combine(ScansDir, "latest.json." + _processId.ToString(CultureInfo.InvariantCulture) + ".tmp");

        /// <summary>True when a record has choices and no error: a record worth keeping.</summary>
        public static bool IsGood(ScanResult record) =>
            record != null && string.IsNullOrEmpty(record.Error) && record.Choices != null && record.Choices.Count > 0;

        /// <summary>
        /// Gives a record without choices and without an error the catalog code
        /// for "nothing found" (SCN-001). Error stays null: nothing failed.
        /// </summary>
        public static void MarkNothingFound(ScanResult record)
        {
            if (record == null || !string.IsNullOrEmpty(record.Error) || !string.IsNullOrEmpty(record.ErrorCode)) return;
            if (record.Choices != null && record.Choices.Count > 0) return;
            ErrorInfo info = ErrorCatalog.Get(NothingFoundCode);
            record.ErrorCode = NothingFoundCode;
            record.ErrorName = info?.Name;
            record.ErrorAction = info?.Action;
        }

        /// <summary>
        /// The notice for a kept record: "Last scan found nothing at 14:32" or
        /// "Last scan failed at 14:32: CAP-001 Shutter" (local time).
        /// </summary>
        public static string NoticeFor(ScanResult attempt, DateTime localTime)
        {
            string time = localTime.ToString("HH:mm", CultureInfo.InvariantCulture);
            if (attempt == null || string.IsNullOrEmpty(attempt.Error))
                return "Last scan found nothing at " + time;
            string code = string.IsNullOrEmpty(attempt.ErrorCode)
                ? string.Empty
                : ": " + (attempt.ErrorCode + " " + (attempt.ErrorName ?? string.Empty)).Trim();
            return "Last scan failed at " + time + code;
        }

        /// <summary>
        /// The record latest.json holds after <paramref name="attempt"/>: the
        /// attempt itself, or (keep-last-good) a copy of <paramref name="latest"/>
        /// with a notice. Pure: reads and writes no file.
        /// </summary>
        public static ScanResult Decide(ScanResult attempt, ScanResult latest, DateTime localTime, out bool keptPrevious)
        {
            keptPrevious = !IsGood(attempt) && IsGood(latest);
            if (!keptPrevious) return attempt;

            ScanResult kept = Copy(latest);
            kept.Notice = NoticeFor(attempt, localTime);
            return kept;
        }

        /// <summary>The record in latest.json, or null when it is missing or unreadable.</summary>
        public ScanResult ReadLatest()
        {
            try
            {
                if (!File.Exists(LatestPath)) return null;
                return JsonConvert.DeserializeObject<ScanResult>(File.ReadAllText(LatestPath));
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is JsonException)
            {
                return null;
            }
        }

        /// <summary>
        /// Publishes one scan record. The pending screenshot (if the caller
        /// wrote one) goes with it, unless the keep-last-good rule keeps the
        /// previous pair; then the pending screenshot is deleted. Returns the
        /// record that latest.json now holds; <paramref name="keptPrevious"/>
        /// tells whether that is the previous record.
        /// </summary>
        public ScanResult Publish(ScanResult attempt, DateTime localTime, out bool keptPrevious)
        {
            MarkNothingFound(attempt);
            ScanResult published = Decide(attempt, ReadLatest(), localTime, out keptPrevious);

            if (keptPrevious) TryDelete(PendingScreenshot);

            File.WriteAllText(PendingRecord, JsonConvert.SerializeObject(published, Formatting.Indented));
            if (!keptPrevious && File.Exists(PendingScreenshot))
                File.Move(PendingScreenshot, ScreenshotPath, overwrite: true);
            File.Move(PendingRecord, LatestPath, overwrite: true);

            WriteHistory(attempt);
            return published;
        }

        /// <summary>One scan-&lt;stamp&gt;.json per record (also an empty or failed one), newest 60 kept.</summary>
        private void WriteHistory(ScanResult attempt)
        {
            string stamp = DateTime.UtcNow.ToString("yyyyMMdd_HHmmssfff", CultureInfo.InvariantCulture);
            string path = Path.Combine(ScansDir, "scan-" + stamp + ".json");
            for (int n = 2; File.Exists(path); n++)
                path = Path.Combine(ScansDir, "scan-" + stamp + "-" + n.ToString(CultureInfo.InvariantCulture) + ".json");
            File.WriteAllText(path, JsonConvert.SerializeObject(attempt, Formatting.Indented));

            foreach (FileInfo old in new DirectoryInfo(ScansDir).GetFiles("*.json")
                .OrderByDescending(f => f.LastWriteTimeUtc)
                .Skip(RetentionFiles))
            {
                TryDelete(old.FullName); // the next scan retries
            }
        }

        /// <summary>
        /// Deletes pending files that a killed scan left behind: those whose
        /// process is gone, and any older than ten minutes. A scan still running
        /// in another process keeps its own.
        /// </summary>
        public void DeleteStalePending()
        {
            DateTime cutoff = DateTime.UtcNow.AddMinutes(-10);
            FileInfo[] pendingFiles;
            try
            {
                pendingFiles = new DirectoryInfo(ScansDir).GetFiles("*.tmp");
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
            {
                return; // best-effort
            }

            foreach (FileInfo pending in pendingFiles)
            {
                // last.png.<pid>.tmp / latest.json.<pid>.tmp
                string name = pending.Name;
                if (!name.StartsWith("last.png.", StringComparison.Ordinal) &&
                    !name.StartsWith("latest.json.", StringComparison.Ordinal))
                    continue;
                string[] parts = name.Split('.');
                bool ownerGone = parts.Length >= 4 &&
                    int.TryParse(parts[parts.Length - 2], NumberStyles.None, CultureInfo.InvariantCulture, out int pid) &&
                    pid != _processId && !ProcessRunning(pid);
                if (ownerGone || pending.LastWriteTimeUtc < cutoff) TryDelete(pending.FullName);
            }
        }

        private static bool ProcessRunning(int pid)
        {
            try
            {
                using (Process process = Process.GetProcessById(pid))
                    return !process.HasExited;
            }
            catch (ArgumentException)
            {
                return false;
            }
            catch (InvalidOperationException)
            {
                return false;
            }
        }

        private static ScanResult Copy(ScanResult record) =>
            JsonConvert.DeserializeObject<ScanResult>(JsonConvert.SerializeObject(record));

        private static void TryDelete(string path)
        {
            try
            {
                if (!string.IsNullOrEmpty(path) && File.Exists(path)) File.Delete(path);
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
            {
                // best-effort; the next scan retries
            }
        }
    }
}

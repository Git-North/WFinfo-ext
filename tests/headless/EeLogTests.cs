using System;
using System.IO;
using System.Linq;
using WFInfo.Scan;
using Xunit;

namespace WFInfo.Headless.Tests
{
    public sealed class EeLogTriggerTests
    {
        [Theory]
        [InlineData("2011.1 Script [Info]: ProjectionRewardChoice.lua: Got rewards", "Got rewards")]
        [InlineData("GOT REWARDS", "Got rewards")]
        [InlineData("x pause countdown done y", "Pause countdown done")]
        public void A_reward_line_matches_and_only_the_phrase_comes_back(string line, string phrase)
        {
            Assert.True(EeLog.IsRewardTrigger(line));
            Assert.Equal(phrase, EeLog.MatchTrigger(line));
        }

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("Got reward")]
        [InlineData("Pause countdown started")]
        [InlineData("Sys [Info]: Logged in user@example.invalid")]
        public void Other_lines_do_not_match(string line)
        {
            Assert.False(EeLog.IsRewardTrigger(line));
            Assert.Null(EeLog.MatchTrigger(line));
        }
    }

    /// <summary>
    /// Finding EE.log and reading EE.cfg. HOME points into a temporary folder,
    /// so the user's own Steam and CrossOver folders are never read.
    /// </summary>
    public sealed class EeLogDiscoveryTests : IDisposable
    {
        private const string Prefix = "steamapps/compatdata/230410/pfx/drive_c/users/steamuser/AppData/Local/Warframe/EE.log";
        private const string Bottle =
            "Library/Application Support/CrossOver/Bottles/wf/drive_c/users/crossover/AppData/Local/Warframe/EE.log";

        private readonly TempDir _dir = new TempDir();
        private readonly EnvScope _env;
        private readonly string _home;

        public EeLogDiscoveryTests()
        {
            _home = Directory.CreateDirectory(_dir.File("home")).FullName;
            _env = new EnvScope(("HOME", _home), ("WFINFO_EE_LOG", null), ("STEAM_ROOT", null));
        }

        public void Dispose()
        {
            _env.Dispose();
            _dir.Dispose();
        }

        private string Log(string relative, int ageMinutes)
        {
            string path = _dir.Write(relative, "log\n");
            File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddMinutes(-ageMinutes));
            return path;
        }

        /// <summary>Paths compare after resolving /var → /private/var and friends.</summary>
        private static string Tail(string path) => path.Substring(path.IndexOf("wfinfo-test-", StringComparison.Ordinal));

        [Fact]
        public void An_explicit_path_wins_and_a_missing_one_gives_nothing()
        {
            string log = Log("explicit/EE.log", 0);
            _env.Set("WFINFO_EE_LOG", Log("env/EE.log", 0));

            Assert.Equal(log, EeLog.Resolve(log));
            Assert.Null(EeLog.Resolve(_dir.File("no/EE.log")));
        }

        [UnixFact]
        public void The_environment_override_is_used_only_when_its_file_exists()
        {
            string steam = Log("home/.local/share/Steam/" + Prefix, 0);
            string chosen = Log("env/EE.log", 60);

            _env.Set("WFINFO_EE_LOG", chosen);
            Assert.Equal(Tail(chosen), Tail(EeLog.Resolve(null)));

            _env.Set("WFINFO_EE_LOG", _dir.File("gone/EE.log"));
            Assert.Equal(Tail(steam), Tail(EeLog.Resolve(null)));
        }

        [UnixFact]
        public void With_nothing_installed_there_is_no_log()
        {
            Assert.Null(EeLog.Resolve(null));
        }

        [UnixFact]
        public void The_newest_log_of_Steam_and_CrossOver_wins()
        {
            string steam = Log("home/.local/share/Steam/" + Prefix, 30);
            string bottle = Log("home/" + Bottle, 5);
            Assert.Equal(Tail(bottle), Tail(EeLog.Resolve(null)));

            File.SetLastWriteTimeUtc(steam, DateTime.UtcNow);
            Assert.Equal(Tail(steam), Tail(EeLog.Resolve(null)));
        }

        [UnixFact]
        public void Extra_Steam_libraries_and_STEAM_ROOT_are_searched()
        {
            string library = Log("drive2/SteamLibrary/" + Prefix, 20);
            string libraryRoot = _dir.File("drive2/SteamLibrary");
            _dir.Write("home/.local/share/Steam/steamapps/libraryfolders.vdf",
                "\"libraryfolders\"\n{\n  \"1\"\n  {\n    \"path\"\t\t\"" + libraryRoot + "\"\n  }\n}\n");
            Assert.Equal(Tail(library), Tail(EeLog.Resolve(null)));

            string custom = Log("custom/Steam/" + Prefix, 1);
            _env.Set("STEAM_ROOT", _dir.File("custom/Steam"));
            Assert.Equal(Tail(custom), Tail(EeLog.Resolve(null)));
        }

        [UnixFact]
        public void The_candidate_paths_name_the_Proton_prefix_of_each_Steam_root()
        {
            Directory.CreateDirectory(_dir.File("home/.local/share/Steam"));
            string candidate = Assert.Single(EeLog.CandidatePaths());
            Assert.EndsWith("Steam/" + Prefix, candidate);
        }

        [Theory]
        [InlineData("Flash.FlashDrawScale=0.9", 0.9)]
        [InlineData("flash.flashdrawscale= 0.8733 ", 0.85)]
        [InlineData("Flash.FlashDrawScale=0.8999999", 0.9)]
        [InlineData("Flash.FlashDrawScale=2.0", 1.25)]
        [InlineData("Flash.FlashDrawScale=0.1", 0.5)]
        [InlineData("Graphics.Quality=3", 1.0)]
        public void The_UI_scale_follows_WFInfos_rule(string line, double expected)
        {
            string log = Log("cfg/EE.log", 0);
            _dir.Write("cfg/EE.cfg", "[LotusGame]\n" + line + "\n");

            Assert.Equal(expected, EeLog.ReadUiScale(log));
        }

        [Fact]
        public void An_unreadable_UI_scale_is_unknown()
        {
            string log = Log("cfg/EE.log", 0);
            Assert.Null(EeLog.ReadUiScale(log)); // no EE.cfg

            _dir.Write("cfg/EE.cfg", "Flash.FlashDrawScale=large\n");
            Assert.Null(EeLog.ReadUiScale(log));

            Assert.Null(EeLog.ReadUiScale(_dir.File("no/EE.log"))); // no log
        }
    }

    public sealed class LogTailTests : IDisposable
    {
        private readonly TempDir _dir = new TempDir();
        private readonly string _log;

        public LogTailTests() => _log = _dir.Write("EE.log", "old Got rewards\n");

        public void Dispose() => _dir.Dispose();

        /// <summary>Every new complete line.</summary>
        private static string[] Read(LogTail tail) => tail.ReadNewMatches(line => line).ToArray();

        [Fact]
        public void Reading_starts_at_the_end_of_the_file()
        {
            var tail = new LogTail(_log);
            Assert.Empty(Read(tail));

            File.AppendAllText(_log, "one\r\ntwo\n");
            Assert.Equal(new[] { "one", "two" }, Read(tail));
            Assert.Empty(Read(tail));
        }

        [Fact]
        public void A_partial_line_waits_for_its_newline()
        {
            var tail = new LogTail(_log);
            File.AppendAllText(_log, "whole\nGot rew");
            Assert.Equal(new[] { "whole" }, Read(tail));

            File.AppendAllText(_log, "ards\n");
            Assert.Equal(new[] { "Got rewards" }, Read(tail));
        }

        [Fact]
        public void Offsets_count_bytes_so_non_ASCII_text_is_not_read_twice()
        {
            var tail = new LogTail(_log);
            File.AppendAllText(_log, "Zoë — 名前 ✓\n");
            Assert.Equal(new[] { "Zoë — 名前 ✓" }, Read(tail));

            File.AppendAllText(_log, "next\n");
            Assert.Equal(new[] { "next" }, Read(tail));
        }

        [Fact]
        public void A_truncated_log_is_read_from_the_start()
        {
            var tail = new LogTail(_log);
            File.WriteAllText(_log, "new\n");
            Assert.Equal(new[] { "new" }, Read(tail));
        }

        [Fact]
        public void A_longer_replacement_log_is_read_from_the_start()
        {
            var tail = new LogTail(_log);
            File.AppendAllText(_log, "first session\n");
            Read(tail);

            File.Delete(_log);
            string[] session = Enumerable.Range(0, 20).Select(i => "second session line " + i).ToArray();
            File.WriteAllText(_log, string.Join("\n", session) + "\n");

            Assert.Equal(session, Read(tail));
        }

        [Fact]
        public void A_log_that_does_not_exist_yet_is_read_once_it_appears()
        {
            string later = _dir.File("later.log");
            var tail = new LogTail(later);
            Assert.Empty(Read(tail));

            File.WriteAllText(later, "hello\n");
            Assert.Equal(new[] { "hello" }, Read(tail));
        }

        [Fact]
        public void Only_matches_leave_the_tail()
        {
            var tail = new LogTail(_log);
            File.AppendAllText(_log, "e-mail someone@example.invalid\nScript: Got rewards\n");

            Assert.Equal(new[] { "Got rewards" }, tail.ReadNewMatches(EeLog.MatchTrigger));
        }
    }
}

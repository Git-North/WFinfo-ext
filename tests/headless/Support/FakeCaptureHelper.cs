using System;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using WFInfo.MacOS;

namespace WFInfo.Headless.Tests
{
    /// <summary>
    /// A stand-in for wfinfo-mac's live capture, which needs the Screen
    /// Recording permission. `displays` lists two displays (id 2 first, the main
    /// one is id 1). `rewards` writes a marker to the --save path and answers
    /// from a canned file named after its target: display-1.json,
    /// display-2.json or window-42.json. A file "first-call-empty" makes the
    /// first `rewards` call answer with no lines.
    /// </summary>
    internal sealed class FakeCaptureHelper : IDisposable
    {
        private readonly TempDir _dir = new TempDir();

        public FakeCaptureHelper()
        {
            _dir.Write("displays.json", """[{"id":2,"main":false},{"id":1,"main":true}]""");
            string fix = _dir.Root;
            Path = Helpers.Script(_dir, $$"""
                fix='{{fix}}'
                command=$1
                echo "$*" >> "$fix/calls"
                shift
                display= window= save=
                while [ $# -gt 0 ]; do
                  case $1 in
                    --display) display=$2; shift ;;
                    --window) window=$2; shift ;;
                    --save) save=$2; shift ;;
                  esac
                  shift
                done
                case $command in
                  displays) cat "$fix/displays.json" ;;
                  selfcheck) cat "$fix/selfcheck.json" ;;
                  rewards)
                    if [ -n "$window" ]; then key=window-$window; else key=display-$display; fi
                    if [ -f "$fix/fail" ]; then echo "wfinfo-mac: $(cat "$fix/fail")" >&2; exit 1; fi
                    if [ -n "$save" ]; then printf 'capture of %s' "$key" > "$save"; fi
                    if [ -f "$fix/first-call-empty" ]; then rm "$fix/first-call-empty"; key=empty; fi
                    sed "s|__SAVE__|$save|" "$fix/$key.json" ;;
                esac
                """);
        }

        public string Path { get; }

        public void Write(string name, string text) => _dir.Write(name, text);

        /// <summary>Canned answers for a target: the real helper's answer, with or without its lines.</summary>
        public void Answer(string key, JObject real, bool withLines)
        {
            var answer = (JObject)real.DeepClone();
            answer["saved"] = "__SAVE__";
            answer["source"] = key;
            if (!withLines) answer["lines"] = new JArray();
            _dir.Write(key + ".json", answer.ToString());
        }

        /// <summary>The argument lines of every call to the given subcommand.</summary>
        public string[] Calls(string command)
        {
            string log = _dir.File("calls");
            return File.Exists(log)
                ? File.ReadAllLines(log).Where(line => line.StartsWith(command, StringComparison.Ordinal)).ToArray()
                : Array.Empty<string>();
        }

        public void Dispose() => _dir.Dispose();
    }

    /// <summary>One synthetic reward screen and the real helper's reading of it, drawn once per test class.</summary>
    public sealed class RewardScreen : IDisposable
    {
        public const string Names =
            "Volt Prime Systems Blueprint|Ash Prime Neuroptics Blueprint|Forma Blueprint|Akstiletto Prime Barrel";

        public static readonly string[] Parts =
            { "Volt Prime Systems", "Ash Prime Neuroptics", "Forma Blueprint", "Akstiletto Prime Barrel" };

        private readonly TempDir _dir = new TempDir();
        private JObject _reading;

        public RewardScreen()
        {
            if (!OperatingSystem.IsMacOS()) return;
            Png = _dir.File("reward.png");
            Run("synth", "--out", Png, "--names", Names, "--ui-scale", "0.9", "--color", "#FFFFFF", "--seed", "7");
        }

        public string Png { get; }

        internal JObject Reading => _reading ??= Run(
            "rewards", "--file", Png, "--reward-width", "968", "--reward-height", "235",
            "--reward-y", "316", "--line-height", "48", "--ui-scale", "0.9");

        internal static JObject Run(params string[] arguments)
        {
            using var env = new EnvScope((MacHelper.Variable, Helpers.Real));
            return (JObject)MacHelper.Run(arguments, 180000);
        }

        public void Dispose() => _dir.Dispose();
    }
}

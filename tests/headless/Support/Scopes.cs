using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;

namespace WFInfo.Headless.Tests
{
    /// <summary>A new folder under TMPDIR, removed on dispose.</summary>
    internal sealed class TempDir : IDisposable
    {
        public TempDir()
        {
            Root = Directory.CreateTempSubdirectory("wfinfo-test-").FullName;
        }

        public string Root { get; }

        public string File(string name) => Path.Combine(Root, name);

        /// <summary>Writes a file below the folder (parents are created) and returns its path.</summary>
        public string Write(string name, string text)
        {
            string path = File(name);
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            System.IO.File.WriteAllText(path, text);
            return path;
        }

        public void Dispose()
        {
            if (Directory.Exists(Root)) Directory.Delete(Root, recursive: true);
        }
    }

    /// <summary>Sets environment variables (null removes one) and restores them on dispose.</summary>
    internal sealed class EnvScope : IDisposable
    {
        private readonly Dictionary<string, string> _before = new Dictionary<string, string>();

        public EnvScope(params (string Name, string Value)[] variables)
        {
            foreach ((string name, string value) in variables) Set(name, value);
        }

        public void Set(string name, string value)
        {
            if (!_before.ContainsKey(name)) _before[name] = Environment.GetEnvironmentVariable(name);
            Environment.SetEnvironmentVariable(name, value);
        }

        public void Dispose()
        {
            foreach (var pair in _before) Environment.SetEnvironmentVariable(pair.Key, pair.Value);
        }
    }

    /// <summary>A thread-safe text sink that a test can wait on.</summary>
    internal sealed class SharedWriter : TextWriter
    {
        private readonly StringBuilder _text = new StringBuilder();

        public override Encoding Encoding => Encoding.UTF8;

        public override void Write(char value)
        {
            lock (_text) _text.Append(value);
        }

        public override void Write(string value)
        {
            lock (_text) _text.Append(value);
        }

        public override void WriteLine(string value)
        {
            lock (_text) _text.Append(value).Append('\n');
        }

        public override string ToString()
        {
            lock (_text) return _text.ToString();
        }

        public int Count(string part) => ToString().Split(part).Length - 1;

        /// <summary>Waits until <paramref name="part"/> has appeared; fails with the text so far.</summary>
        public void WaitFor(string part, int timeoutMs = 20000)
        {
            if (!SpinWait.SpinUntil(() => ToString().Contains(part, StringComparison.Ordinal), timeoutMs))
                throw new TimeoutException($"no '{part}' within {timeoutMs} ms; output so far:\n{this}");
        }
    }

    /// <summary>Captures Console.Out and Console.Error until dispose.</summary>
    internal sealed class ConsoleCapture : IDisposable
    {
        private readonly TextWriter _out = Console.Out;
        private readonly TextWriter _error = Console.Error;

        public ConsoleCapture()
        {
            Console.SetOut(Out);
            Console.SetError(Error);
        }

        public SharedWriter Out { get; } = new SharedWriter();

        public SharedWriter Error { get; } = new SharedWriter();

        public override string ToString() => string.Join("\n", new[] { Out, Error }.Select(w => w.ToString()));

        public void Dispose()
        {
            Console.SetOut(_out);
            Console.SetError(_error);
        }
    }
}

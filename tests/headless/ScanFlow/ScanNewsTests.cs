using System.Linq;
using WFInfo.Scan;
using Xunit;

namespace WFInfo.Tests.ScanPasses
{
    public class ScanNewsTests
    {
        internal static ScanResult Record(params string[] parts)
        {
            var record = new ScanResult();
            record.Choices.AddRange(parts.Select((part, i) => new ScanChoice { Index = i + 1, Part = part }));
            return record;
        }

        [Fact]
        public void NoPreviousRecordAndNamesIsNew()
        {
            Assert.True(ScanNews.FoundNewNames(null, Record("Forma Blueprint")));
        }

        [Fact]
        public void EmptyCurrentIsNeverNew()
        {
            Assert.False(ScanNews.FoundNewNames(null, Record()));
            Assert.False(ScanNews.FoundNewNames(Record("Forma Blueprint"), Record()));
            Assert.False(ScanNews.FoundNewNames(Record("Forma Blueprint"), null));
        }

        [Fact]
        public void SameNamesInOtherOrderOrCaseAreNotNew()
        {
            ScanResult previous = Record("Volt Prime Blueprint", "Forma Blueprint");
            Assert.False(ScanNews.FoundNewNames(previous, Record("forma blueprint", "Volt Prime Blueprint")));
        }

        [Fact]
        public void OtherOrMoreNamesAreNew()
        {
            ScanResult previous = Record("Volt Prime Blueprint", "Forma Blueprint");
            Assert.True(ScanNews.FoundNewNames(previous, Record("Volt Prime Blueprint", "Ash Prime Neuroptics Blueprint")));
            Assert.True(ScanNews.FoundNewNames(previous, Record("Volt Prime Blueprint", "Forma Blueprint", "Akstiletto Prime Barrel")));
        }
    }
}

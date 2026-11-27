using Tesseract;

namespace WFInfo.MacOS
{
    /// <summary>
    /// ITesseractService for runs that read text with Apple Vision only: no
    /// engine is created and no tessdata is downloaded. The reward pipeline then
    /// gets its texts from the recognizer passed to
    /// OCR.ProcessRewardScreenForTest, never from these (null) engines.
    /// </summary>
    internal sealed class NoTesseractService : ITesseractService
    {
        public TesseractEngine FirstEngine => null;
        public TesseractEngine SecondEngine => null;
        public TesseractEngine[] Engines { get; } = new TesseractEngine[0];
        public TesseractEngine NumbersOnlyEngine => null;

        public void Init()
        {
        }

        public void ReloadEngines()
        {
        }
    }
}

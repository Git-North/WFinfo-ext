using System;

namespace WFInfo.MacOS
{
    /// <summary>
    /// Which text engine a run uses: "vision" (Apple Vision through
    /// wfinfo-mac, macOS) or "tesseract" (WFInfo's own pipeline).
    /// </summary>
    internal static class OcrEngines
    {
        /// <summary>
        /// Resolves a requested engine. Auto, the default, means Vision when the
        /// helper is built on macOS, else Tesseract. <c>WFINFO_OCR_ENGINE</c>
        /// sets the default. Throws <see cref="ArgumentException"/> on bad input,
        /// and on macOS when <c>WFINFO_MAC_HELPER</c> names a missing file.
        /// </summary>
        public static string Resolve(string requested)
        {
            string value = (requested ?? Environment.GetEnvironmentVariable("WFINFO_OCR_ENGINE") ?? "auto")
                .Trim().ToLowerInvariant();
            switch (value)
            {
                case "":
                case "auto":
                    // A set but wrong WFINFO_MAC_HELPER must not fall back to Tesseract silently.
                    MacHelper.CheckConfigured();
                    return MacHelper.Available ? "vision" : "tesseract";
                case "vision":
                    MacHelper.CheckConfigured();
                    if (!MacHelper.Available)
                        throw new ArgumentException("--ocr vision needs macOS and the wfinfo-mac helper (built with the project on macOS)");
                    return "vision";
                case "tesseract":
                    return "tesseract";
                default:
                    throw new ArgumentException($"--ocr expects auto, vision or tesseract, got '{requested}'");
            }
        }
    }
}

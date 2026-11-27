namespace WFInfo.Scan
{
    /// <summary>
    /// WFInfo-ext's own settings: &lt;app dir&gt;/wfinfo-ext-settings.json,
    /// {"version":1,"notifications":false,"overlayPin":false}. Only the
    /// dashboard writes it; the runner reads it at each scan start and at
    /// each watch trigger, so a change applies without a restart.
    /// </summary>
    internal sealed class ExtSettings
    {
        /// <summary>Desktop notifications for EE.log-triggered scans (default off).</summary>
        public bool Notifications { get; private set; }

        /// <summary>Pin the overlay window through the Millennium plugin after a scan with names (default off).</summary>
        public bool OverlayPin { get; private set; }

        /// <summary>
        /// The current settings; defaults (all off) when the file is missing or
        /// unreadable. STUB: the settings work fills this in.
        /// </summary>
        public static ExtSettings Load() => new ExtSettings();
    }
}

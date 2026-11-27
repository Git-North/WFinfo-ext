//! Where the plugin's socket is. The rule is the one in the plugin's
//! `backend/cli_socket.lua` and in its `overlay-pin` demo CLI.

use std::ffi::OsString;
use std::path::PathBuf;

/// Environment variable that names the socket and overrides the per-OS path.
pub const SOCKET_VARIABLE: &str = "OVERLAY_AUTOPIN_SOCKET";

const SOCKET_FILE: &str = "overlay-autopin.sock";

/// The operating systems that have different socket path rules.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    /// macOS.
    MacOs,
    /// Windows.
    Windows,
    /// Linux and every other Unix.
    Unix,
}

impl Os {
    /// The operating system this library was built for.
    #[must_use]
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unix
        }
    }
}

/// The socket path for `os`, with `env` as the environment. An empty variable
/// counts as unset.
///
/// # Errors
/// Returns the reason when the variables the rule needs are not set.
pub fn socket_path(
    os: Os,
    env: impl Fn(&str) -> Option<OsString>,
) -> Result<PathBuf, &'static str> {
    let var = |name: &str| {
        env(name)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    };
    if let Some(path) = var(SOCKET_VARIABLE) {
        return Ok(path);
    }
    match os {
        Os::Windows => var("LOCALAPPDATA")
            .map(|base| base.join("Millennium").join(SOCKET_FILE))
            .ok_or("LOCALAPPDATA is not set"),
        Os::MacOs => var("HOME")
            .map(|home| {
                home.join("Library/Application Support/Millennium")
                    .join(SOCKET_FILE)
            })
            .ok_or("HOME is not set"),
        Os::Unix => var("XDG_RUNTIME_DIR")
            .map(|runtime| runtime.join(SOCKET_FILE))
            .or_else(|| {
                var("HOME").map(|home| home.join(".local/share/millennium").join(SOCKET_FILE))
            })
            .ok_or("neither XDG_RUNTIME_DIR nor HOME is set"),
    }
}

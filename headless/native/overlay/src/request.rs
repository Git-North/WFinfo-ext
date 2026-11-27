//! The caller's JSON request, checked before anything touches the socket.

use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::error::{Error, Kind};

/// How long one call may take when the request names no `timeoutMs`: the
/// demo CLI's default.
pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;

/// The longest `timeoutMs` a request may ask for.
pub const MAX_TIMEOUT_MS: u64 = 60_000;

/// An overlay window the plugin can pin.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Window {
    /// Notes.
    Notes,
    /// Steam's overlay web browser.
    Browser,
    /// Achievements.
    Achievements,
    /// Timer.
    Timer,
    /// Guides.
    Guides,
    /// Discussions.
    Discussions,
}

impl Window {
    /// Every window, in the plugin's order.
    pub const ALL: [Self; 6] = [
        Self::Notes,
        Self::Browser,
        Self::Achievements,
        Self::Timer,
        Self::Guides,
        Self::Discussions,
    ];

    /// The name the plugin knows the window by.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Notes => "notes",
            Self::Browser => "browser",
            Self::Achievements => "achievements",
            Self::Timer => "timer",
            Self::Guides => "guides",
            Self::Discussions => "discussions",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|window| window.name() == name)
    }
}

/// What `pin` and `unpin` act on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    /// One window.
    One(Window),
    /// Every open pinnable window.
    All,
}

impl Target {
    const fn name(self) -> &'static str {
        match self {
            Self::One(window) => window.name(),
            Self::All => "all",
        }
    }
}

/// A command for the plugin. `toggle` takes one window, never `all`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    /// The open pinnable windows and whether they are pinned.
    List,
    /// The plugin's state.
    Status,
    /// Pin.
    Pin(Target),
    /// Unpin.
    Unpin(Target),
    /// Flip one window's pin.
    Toggle(Window),
}

/// A checked request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    /// What to ask the plugin.
    pub command: Command,
    /// `false` asks the plugin not to flash a closed overlay to show the
    /// change at once.
    pub refresh: bool,
    /// The socket to use instead of the default path.
    pub socket: Option<PathBuf>,
    /// The longest the whole call may take.
    pub timeout: Duration,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fields {
    cmd: String,
    window: Option<String>,
    refresh: Option<bool>,
    socket: Option<String>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
}

impl Request {
    /// Reads and checks the caller's JSON.
    ///
    /// # Errors
    /// [`Kind::UnknownWindow`] for a window the plugin does not have, and
    /// [`Kind::BadRequest`] for everything else that is wrong.
    pub fn parse(json: &str) -> Result<Self, Error> {
        let bad = |message: String| Error::new(Kind::BadRequest, message);
        let fields: Fields =
            serde_json::from_str(json).map_err(|e| bad(format!("bad request JSON: {e}")))?;

        let target = fields.window.as_deref().map(parse_target).transpose()?;
        let cmd = fields.cmd.as_str();
        let command = match (cmd, target) {
            ("list", None) => Command::List,
            ("status", None) => Command::Status,
            ("pin", Some(target)) => Command::Pin(target),
            ("unpin", Some(target)) => Command::Unpin(target),
            ("toggle", Some(Target::One(window))) => Command::Toggle(window),
            ("toggle", Some(Target::All)) => {
                return Err(bad("\"toggle\" needs one window, not \"all\"".into()));
            }
            ("list" | "status", Some(_)) => {
                return Err(bad(format!("\"{cmd}\" takes no window")));
            }
            ("pin" | "unpin" | "toggle", None) => {
                return Err(bad(format!("\"{cmd}\" needs a \"window\"")));
            }
            _ => {
                return Err(bad(format!(
                    "unknown command {cmd:?}; use list, status, pin, unpin or toggle"
                )));
            }
        };

        let timeout_ms = fields.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
        if !(1..=MAX_TIMEOUT_MS).contains(&timeout_ms) {
            return Err(bad(format!(
                "\"timeoutMs\" must be from 1 to {MAX_TIMEOUT_MS}, not {timeout_ms}"
            )));
        }
        if fields.socket.as_deref() == Some("") {
            return Err(bad("\"socket\" must not be empty".into()));
        }

        Ok(Self {
            command,
            refresh: fields.refresh.unwrap_or(true),
            socket: fields.socket.map(PathBuf::from),
            timeout: Duration::from_millis(timeout_ms),
        })
    }

    /// The request line for the plugin, without the newline. The client's own
    /// options (`socket`, `timeoutMs`) are not part of it.
    #[must_use]
    pub fn wire_line(&self) -> String {
        let (cmd, window) = match self.command {
            Command::List => ("list", None),
            Command::Status => ("status", None),
            Command::Pin(target) => ("pin", Some(target.name())),
            Command::Unpin(target) => ("unpin", Some(target.name())),
            Command::Toggle(window) => ("toggle", Some(window.name())),
        };
        let mut line = Map::new();
        line.insert("cmd".into(), cmd.into());
        if let Some(window) = window {
            line.insert("window".into(), window.into());
        }
        if !self.refresh {
            line.insert("refresh".into(), false.into());
        }
        Value::Object(line).to_string()
    }
}

fn parse_target(name: &str) -> Result<Target, Error> {
    if name == "all" {
        return Ok(Target::All);
    }
    Window::from_name(name).map(Target::One).ok_or_else(|| {
        let names = Window::ALL.map(Window::name).join(", ");
        Error::new(
            Kind::UnknownWindow,
            format!("unknown window {name:?}; use one of: {names}, all"),
        )
    })
}

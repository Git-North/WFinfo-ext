//! The plugin's answer line: is it a success, and if not, what kind of failure.

use serde_json::{Map, Value};

use crate::error::{Error, Kind};
use crate::redact;

/// How much of an unreadable answer an error message quotes.
const QUOTE_CHARS: usize = 200;

/// A failed call. `reply` is the plugin's answer when it sent a readable one:
/// a failed `pin all` still lists what happened to each window.
#[derive(Clone, Debug, PartialEq)]
pub struct Failure {
    /// What went wrong.
    pub error: Error,
    /// The plugin's JSON answer, when there is one.
    pub reply: Option<Value>,
}

impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        Self { error, reply: None }
    }
}

/// Reads one answer line.
///
/// # Errors
/// [`Kind::BadAnswer`] when the line is not a JSON object with a boolean
/// `ok`, and the plugin's own failure when `ok` is `false`.
pub fn read(line: &str) -> Result<Value, Failure> {
    let bad = |what: &str| {
        let line = redact::text(line, &redact::homes());
        let mut quote: String = line.chars().take(QUOTE_CHARS).collect();
        if quote.len() < line.len() {
            quote.push('…');
        }
        Failure::from(Error::new(
            Kind::BadAnswer,
            format!("the plugin's answer {what}: {quote:?}"),
        ))
    };
    let value: Value = serde_json::from_str(line).map_err(|_| bad("is not JSON"))?;
    let Some(object) = value.as_object() else {
        return Err(bad("is not a JSON object"));
    };
    match object.get("ok").and_then(Value::as_bool) {
        Some(true) => Ok(value),
        Some(false) => Err(Failure {
            error: plugin_error(object),
            reply: Some(value),
        }),
        None => Err(bad("has no true or false \"ok\"")),
    }
}

/// Classifies `"ok": false` by the plugin's error text (`backend/cli_socket.lua`
/// and `frontend/remote.ts` in the plugin).
fn plugin_error(object: &Map<String, Value>) -> Error {
    let Some(text) = object.get("error").and_then(Value::as_str) else {
        return Error::new(
            Kind::PluginFailed,
            "the plugin reported a failure without a reason",
        );
    };
    let kind = if text.starts_with("backend: ") || text.starts_with("frontend: ") {
        Kind::PluginNotReady
    } else if text.starts_with("unknown window ") {
        Kind::UnknownWindow
    } else if text.starts_with("no ") && text.contains(" window is open") {
        Kind::WindowNotOpen
    } else {
        Kind::PluginFailed
    };
    Error::new(kind, format!("the plugin reported: {text}"))
}

//! `WFInfo`'s client for the Overlay Auto-Pin Millennium plugin
//! (Git-North/steam-overlay-pin), which pins Steam overlay windows.
//!
//! One call is one connection to the plugin's Unix socket: one JSON request
//! line, one JSON answer line. Nothing runs between `WFInfo` and the plugin, and
//! the library touches nothing but that socket: not Steam, not the game.
//!
//! # C ABI
//!
//! - `wfinfo_overlay(const char *request) -> char *answer`
//! - `wfinfo_overlay_free(char *answer)`
//!
//! Request: `{"cmd": "list"|"status"|"pin"|"unpin"|"toggle", "window": ...}`.
//! `pin`, `unpin` and `toggle` need `window`: `notes`, `browser`,
//! `achievements`, `timer`, `guides`, `discussions`, or `all` (not for
//! `toggle`). Optional: `refresh` (`false`: do not flash a closed overlay),
//! `socket` (path; default: see [`socket_path`]) and `timeoutMs` (1 to
//! 60000, default 10000; it covers the whole call). Other keys are refused.
//!
//! Answer, success: `{"ok": true, "reply": <the plugin's answer>}`.
//!
//! Answer, failure:
//! `{"ok": false, "error": {"code": "PLG-001", "name": "Vacancy",
//! "message": "..."}}`, with `reply` too when the plugin sent a readable
//! answer (a failed `pin all` still lists each window). The codes are in
//! errors/catalog.json; a panic gets a generated `GEN-` code. A failure
//! answer writes the home folder as `~`.

mod answer;
mod codes;
mod error;
mod ffi;
mod redact;
mod request;
mod socket_path;
mod transport;

use serde_json::{Map, Value};

pub use answer::{Failure, read as read_answer};
pub use codes::{Code, PANIC_INPUT, WORDS, fnv1a32, generated};
pub use error::{Error, Kind};
pub use ffi::{wfinfo_overlay, wfinfo_overlay_free};
pub use request::{Command, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, Request, Target, Window};
pub use socket_path::{Os, SOCKET_VARIABLE, socket_path};
pub use transport::{MAX_ANSWER_BYTES, exchange};

/// Sends a checked request to the plugin and returns the plugin's answer.
///
/// # Errors
/// A [`Failure`] for every way the exchange, or the plugin, can fail.
pub fn call(request: &Request) -> Result<Value, Failure> {
    let path = match &request.socket {
        Some(path) => path.clone(),
        None => socket_path(Os::current(), |name| std::env::var_os(name)).map_err(|why| {
            Error::new(
                Kind::NoSocketPath,
                format!("cannot find the plugin socket: {why}; set {SOCKET_VARIABLE}"),
            )
        })?,
    };
    let line = exchange(&path, &request.wire_line(), request.timeout)?;
    read_answer(&line)
}

/// The whole step on JSON text: the C ABI is a thin shell around this.
#[must_use]
pub fn handle(request_json: &str) -> String {
    let outcome = Request::parse(request_json)
        .map_err(Failure::from)
        .and_then(|request| call(&request));
    match outcome {
        Ok(reply) => {
            let mut answer = Map::new();
            answer.insert("ok".into(), true.into());
            answer.insert("reply".into(), reply);
            Value::Object(answer).to_string()
        }
        Err(failure) => failure_json(&failure),
    }
}

fn failure_json(failure: &Failure) -> String {
    let homes = redact::homes();
    let Code { code, name } = failure.error.kind.code();
    let mut error = Map::new();
    error.insert("code".into(), code.into());
    error.insert("name".into(), name.into());
    error.insert(
        "message".into(),
        redact::text(&failure.error.message, &homes).into(),
    );
    let mut answer = Map::new();
    answer.insert("ok".into(), false.into());
    answer.insert("error".into(), Value::Object(error));
    if let Some(reply) = &failure.reply {
        let mut reply = reply.clone();
        redact::value(&mut reply, &homes);
        answer.insert("reply".into(), reply);
    }
    Value::Object(answer).to_string()
}

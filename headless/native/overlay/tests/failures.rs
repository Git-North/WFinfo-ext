//! Every way to the plugin can fail, and the plugin's own failures.

mod common;

use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use common::{Behavior, FakePlugin, TestDir, ask, bind};
use serde_json::{Value, json};
use wfinfo_overlay::{Failure, Kind, MAX_ANSWER_BYTES, exchange};

fn list(socket: &Path) -> Result<Value, Failure> {
    ask(socket, &json!({"cmd": "list"}))
}

fn failed(result: Result<Value, Failure>) -> Failure {
    result.expect_err("the call must fail")
}

#[track_caller]
fn assert_kind(failure: &Failure, kind: Kind, message_part: &str) {
    assert_eq!(failure.error.kind, kind, "{}", failure.error);
    assert!(
        failure.error.message.contains(message_part),
        "{:?} does not say {message_part:?}",
        failure.error.message
    );
}

/// Runs `list` against a fake plugin with `behavior`.
fn against(behavior: Behavior) -> Failure {
    let dir = TestDir::new();
    let _plugin = FakePlugin::start(&dir.socket(), behavior);
    failed(list(&dir.socket()))
}

#[test]
fn plugin_missing() {
    let dir = TestDir::new();
    let start = Instant::now();
    let failure = failed(list(&dir.socket()));
    assert_kind(&failure, Kind::SocketMissing, "Is Steam running");
    assert!(failure.error.message.contains("p.sock"));
    assert!(start.elapsed() < Duration::from_millis(500), "no retry");
}

#[test]
fn stale_socket_file_is_refused_after_the_retries() {
    let dir = TestDir::new();
    drop(bind(&dir.socket())); // the file stays, nothing listens
    let start = Instant::now();
    assert_kind(
        &failed(list(&dir.socket())),
        Kind::Refused,
        "nothing answers",
    );
    // The retry waits add up to 775 ms.
    assert!(
        start.elapsed() >= Duration::from_millis(775),
        "{:?}",
        start.elapsed()
    );
    assert!(
        start.elapsed() < Duration::from_secs(4),
        "{:?}",
        start.elapsed()
    );
}

#[test]
fn a_short_timeout_stops_the_retries_and_still_says_refused() {
    let dir = TestDir::new();
    drop(bind(&dir.socket()));
    let start = Instant::now();
    let failure = failed(ask(&dir.socket(), &json!({"cmd": "list", "timeoutMs": 60})));
    assert_kind(&failure, Kind::Refused, "nothing answers");
    assert!(
        start.elapsed() < Duration::from_millis(700),
        "{:?}",
        start.elapsed()
    );
}

#[test]
fn refused_then_up() {
    let dir = TestDir::new();
    let socket = dir.socket();
    let listener = bind(&socket);
    let plugin = thread::spawn(move || {
        thread::sleep(Duration::from_millis(150));
        FakePlugin::serve(listener, Behavior::line(r#"{"ok":true}"#))
    });
    let result = list(&socket);
    let plugin = plugin.join().expect("plugin thread");
    assert_eq!(result, Ok(json!({"ok": true})));
    assert_eq!(plugin.requests().len(), 1);
}

#[test]
fn a_restarting_plugin_that_replaces_its_socket_is_reached() {
    let dir = TestDir::new();
    let socket = dir.socket();
    drop(bind(&socket)); // refused at first
    let plugin = {
        let socket = socket.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            std::fs::remove_file(&socket).expect("remove the stale socket");
            thread::sleep(Duration::from_millis(150));
            FakePlugin::start(&socket, Behavior::line(r#"{"ok":true}"#))
        })
    };
    let result = list(&socket);
    let _plugin = plugin.join().expect("plugin thread");
    assert_eq!(result, Ok(json!({"ok": true})));
}

#[test]
fn a_hung_plugin_that_never_accepts_cannot_hold_the_caller() {
    let dir = TestDir::new();
    let listener = bind(&dir.socket());
    listener.listen(1).expect("listen");
    // Fill the queue with connects that are never accepted. Its real size
    // depends on the system, so connect until one fails.
    let address = socket2::SockAddr::unix(dir.socket()).expect("address");
    let mut waiting = Vec::new();
    let full = (0..1024).any(|_| {
        let client = socket2::Socket::new(socket2::Domain::UNIX, socket2::Type::STREAM, None)
            .expect("socket");
        client.set_nonblocking(true).expect("non-blocking");
        let failed = client.connect(&address).is_err();
        waiting.push(client);
        failed
    });
    assert!(full, "the queue never filled");
    let start = Instant::now();
    let failure = failed(ask(
        &dir.socket(),
        &json!({"cmd": "list", "timeoutMs": 1500}),
    ));
    assert!(
        start.elapsed() < Duration::from_secs(4),
        "{:?}",
        start.elapsed()
    );
    // Linux reports a full queue as "try again", macOS as a refusal.
    let expected = if cfg!(target_os = "linux") {
        Kind::Timeout
    } else {
        Kind::Refused
    };
    assert_eq!(failure.error.kind, expected, "{}", failure.error);
}

#[test]
fn timeout_when_the_plugin_never_answers() {
    let dir = TestDir::new();
    let _plugin = FakePlugin::start(&dir.socket(), Behavior::Silent);
    let start = Instant::now();
    let failure = failed(ask(
        &dir.socket(),
        &json!({"cmd": "list", "timeoutMs": 300}),
    ));
    assert_kind(&failure, Kind::Timeout, "no answer within 300 ms");
    assert!(
        start.elapsed() >= Duration::from_millis(300),
        "{:?}",
        start.elapsed()
    );
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "{:?}",
        start.elapsed()
    );
}

#[test]
fn the_timeout_covers_an_answer_that_trickles_in() {
    let dir = TestDir::new();
    let _plugin = FakePlugin::start(&dir.socket(), Behavior::Trickle(Duration::from_millis(40)));
    let start = Instant::now();
    let failure = failed(ask(
        &dir.socket(),
        &json!({"cmd": "list", "timeoutMs": 400}),
    ));
    assert_kind(&failure, Kind::Timeout, "no answer within 400 ms");
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "{:?}",
        start.elapsed()
    );
}

/// More than any socket buffer holds, so the send itself has to wait.
fn long_line() -> String {
    "x".repeat(8 * 1024 * 1024)
}

#[test]
fn the_timeout_covers_a_send_that_the_plugin_does_not_read() {
    let dir = TestDir::new();
    let _plugin = FakePlugin::start(&dir.socket(), Behavior::NeverRead);
    let start = Instant::now();
    let error = exchange(&dir.socket(), &long_line(), Duration::from_millis(300))
        .expect_err("the send cannot finish");
    assert_eq!(error.kind, Kind::Timeout, "{error}");
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "{:?}",
        start.elapsed()
    );
}

#[test]
fn a_close_during_the_send_is_an_error_and_not_a_signal() {
    let dir = TestDir::new();
    let _plugin = FakePlugin::start(&dir.socket(), Behavior::CloseAtOnce);
    let error = exchange(&dir.socket(), &long_line(), Duration::from_secs(5))
        .expect_err("the send cannot finish");
    assert!(matches!(error.kind, Kind::Io | Kind::NoAnswer), "{error}");
}

#[test]
fn closed_without_an_answer() {
    assert_kind(
        &against(Behavior::Send(Vec::new())),
        Kind::NoAnswer,
        "without an answer",
    );
    assert_kind(
        &against(Behavior::line("   ")),
        Kind::NoAnswer,
        "without an answer",
    );
}

#[test]
fn closed_before_the_request_is_read() {
    // The send can win or lose the race with the close; neither may raise
    // SIGPIPE or hang.
    for _ in 0..20 {
        let failure = against(Behavior::CloseAtOnce);
        assert!(
            matches!(failure.error.kind, Kind::NoAnswer | Kind::Io),
            "{:?}",
            failure.error
        );
    }
}

#[test]
fn garbage_answer() {
    let failure = against(Behavior::line("<html>busy</html>"));
    assert_kind(&failure, Kind::BadAnswer, "is not JSON");
    assert!(failure.error.message.contains("<html>busy</html>"));
    assert_eq!(failure.reply, None);
}

#[test]
fn json_that_is_not_the_protocol() {
    for (answer, why) in [
        ("[1,2]", "is not a JSON object"),
        ("\"ok\"", "is not a JSON object"),
        ("{}", "has no true or false"),
        (r#"{"ok":"yes"}"#, "has no true or false"),
        (r#"{"ok":true} {"ok":true}"#, "is not JSON"),
    ] {
        assert_kind(&against(Behavior::line(answer)), Kind::BadAnswer, why);
    }
}

#[test]
fn deeply_nested_json_is_refused_without_a_stack_overflow() {
    let failure = against(Behavior::line(&"[".repeat(100_000)));
    assert_kind(&failure, Kind::BadAnswer, "is not JSON");
}

#[test]
fn a_long_garbage_answer_is_quoted_in_part() {
    let failure = against(Behavior::line(&"é".repeat(5_000)));
    assert_kind(&failure, Kind::BadAnswer, "…");
    assert!(failure.error.message.chars().count() < 300);
}

#[test]
fn answer_that_is_not_utf8() {
    let failure = against(Behavior::Send(vec![0xff, 0xfe, b'\n']));
    assert_kind(&failure, Kind::BadAnswer, "not UTF-8");
}

#[test]
fn answer_too_large() {
    let failure = against(Behavior::Send(vec![b'x'; MAX_ANSWER_BYTES + 1]));
    assert_kind(&failure, Kind::AnswerTooLarge, "longer than");
}

#[test]
fn the_plugin_reports_why_it_failed() {
    // The texts are the plugin's own (cli_socket.lua and remote.ts).
    for (text, kind) in [
        (
            "frontend: no answer (is the plugin's frontend loaded?)",
            Kind::PluginNotReady,
        ),
        ("backend: attempt to call a nil value", Kind::PluginNotReady),
        (
            "no browser window is open; open it once in the overlay (Shift+Tab)",
            Kind::WindowNotOpen,
        ),
        (
            "unknown window \"map\"; use one of: notes, browser, all",
            Kind::UnknownWindow,
        ),
        (
            "cannot list Steam popups (g_PopupManager.GetPopups() unavailable)",
            Kind::PluginFailed,
        ),
        ("bad JSON: Unexpected token", Kind::PluginFailed),
    ] {
        let reply = json!({"ok": false, "error": text});
        let failure = against(Behavior::json(&reply));
        assert_kind(&failure, kind, text);
        assert_eq!(failure.reply, Some(reply));
    }
}

#[test]
fn a_failed_change_keeps_the_results() {
    let reply = json!({
        "ok": false, "cmd": "pin", "error": "browser: no pin button found",
        "results": [{"window": "browser", "pinned": false, "error": "no pin button found"}],
    });
    let failure = against(Behavior::json(&reply));
    assert_kind(&failure, Kind::PluginFailed, "browser: no pin button found");
    assert_eq!(failure.reply, Some(reply));
}

#[test]
fn a_failure_without_a_reason() {
    let failure = against(Behavior::line(r#"{"ok":false}"#));
    assert_kind(&failure, Kind::PluginFailed, "without a reason");
}

#[cfg(unix)]
mod unix {
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};

    use super::*;

    #[test]
    fn a_regular_file_at_the_path_is_left_alone() {
        let dir = TestDir::new();
        fs::write(dir.socket(), "keep me").expect("write");
        assert_kind(
            &failed(list(&dir.socket())),
            Kind::NotASocket,
            "is not a socket",
        );
        assert_eq!(fs::read_to_string(dir.socket()).expect("read"), "keep me");
    }

    #[test]
    fn a_path_too_long_for_a_socket() {
        let dir = TestDir::new();
        let _plugin = FakePlugin::start(&dir.socket(), Behavior::Silent);
        let long = dir.path().join("l".repeat(120));
        symlink(dir.socket(), &long).expect("symlink");
        assert_kind(
            &failed(list(&long)),
            Kind::BadSocketPath,
            "as a socket path",
        );
    }

    #[test]
    fn a_path_below_a_regular_file_cannot_be_connected() {
        let dir = TestDir::new();
        fs::write(dir.socket(), "").expect("write");
        let failure = failed(list(&dir.socket().join("below")));
        assert_kind(&failure, Kind::ConnectFailed, "cannot connect");
    }

    #[test]
    fn no_permission_to_reach_the_socket() {
        let dir = TestDir::new();
        let locked = dir.path().join("locked");
        fs::create_dir(&locked).expect("mkdir");
        let socket = locked.join("p.sock");
        let _plugin = FakePlugin::start(&socket, Behavior::Silent);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).expect("chmod");
        // root ignores permissions; then there is nothing to test.
        let result = fs::metadata(&socket)
            .is_err()
            .then(|| failed(list(&socket)));
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).expect("chmod back");
        if let Some(failure) = result {
            assert_kind(&failure, Kind::SocketPermission, "no permission");
        }
    }
}

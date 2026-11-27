//! A working fake plugin: what the client sends and what it accepts.

mod common;

use std::time::{Duration, Instant};

use common::{Behavior, FakePlugin, TestDir, ask};
use serde_json::{Value, json};

#[test]
fn each_command_sends_one_request_line_without_client_options() {
    let cases: [(Value, &str); 7] = [
        (json!({"cmd": "list"}), r#"{"cmd":"list"}"#),
        (json!({"cmd": "status"}), r#"{"cmd":"status"}"#),
        (
            json!({"cmd": "pin", "window": "browser"}),
            r#"{"cmd":"pin","window":"browser"}"#,
        ),
        (
            json!({"cmd": "pin", "window": "browser", "refresh": true}),
            r#"{"cmd":"pin","window":"browser"}"#,
        ),
        (
            json!({"cmd": "pin", "window": "guides", "refresh": false}),
            r#"{"cmd":"pin","window":"guides","refresh":false}"#,
        ),
        (
            json!({"cmd": "unpin", "window": "all"}),
            r#"{"cmd":"unpin","window":"all"}"#,
        ),
        (
            json!({"cmd": "toggle", "window": "notes"}),
            r#"{"cmd":"toggle","window":"notes"}"#,
        ),
    ];
    for (request, wire) in cases {
        let dir = TestDir::new();
        let plugin = FakePlugin::start(&dir.socket(), Behavior::json(&json!({"ok": true})));
        ask(&dir.socket(), &request).expect("success");
        let sent = plugin.requests();
        assert_eq!(sent.len(), 1, "one request per call");
        let line = sent[0].strip_suffix('\n').expect("ends with a newline");
        let sent: Value = serde_json::from_str(line).expect("JSON");
        let wire: Value = serde_json::from_str(wire).expect("JSON");
        assert_eq!(sent, wire, "for {request}");
    }
}

#[test]
fn every_window_name_is_accepted() {
    let dir = TestDir::new();
    let plugin = FakePlugin::start(&dir.socket(), Behavior::line(r#"{"ok":true}"#));
    for window in wfinfo_overlay::Window::ALL {
        ask(
            &dir.socket(),
            &json!({"cmd": "pin", "window": window.name()}),
        )
        .expect("success");
    }
    assert_eq!(plugin.requests().len(), 6);
}

#[test]
fn the_plugin_answer_comes_back_whole() {
    let reply = json!({
        "ok": true, "cmd": "pin", "overlayOpen": false, "refreshed": true,
        "results": [{"window": "browser", "before": false, "pinned": true, "changed": true}],
    });
    let dir = TestDir::new();
    let _plugin = FakePlugin::start(&dir.socket(), Behavior::json(&reply));
    let got = ask(&dir.socket(), &json!({"cmd": "pin", "window": "browser"}));
    assert_eq!(got, Ok(reply));
}

#[test]
fn an_answer_may_end_at_the_close_instead_of_a_newline() {
    let dir = TestDir::new();
    let _plugin = FakePlugin::start(&dir.socket(), Behavior::Send(br#"{"ok":true}"#.to_vec()));
    assert_eq!(
        ask(&dir.socket(), &json!({"cmd": "list"})),
        Ok(json!({"ok": true}))
    );
}

#[test]
fn an_answer_may_arrive_in_pieces() {
    let pieces = [&br#"{"ok":"#[..], b"true,", b"\"n\":1}", b"\n"]
        .map(<[u8]>::to_vec)
        .to_vec();
    let dir = TestDir::new();
    let _plugin = FakePlugin::start(
        &dir.socket(),
        Behavior::SendPieces(pieces, Duration::from_millis(15)),
    );
    assert_eq!(
        ask(&dir.socket(), &json!({"cmd": "list"})),
        Ok(json!({"ok": true, "n": 1}))
    );
}

#[test]
fn the_newline_ends_the_answer_while_the_connection_stays_open() {
    let dir = TestDir::new();
    let _plugin = FakePlugin::start(
        &dir.socket(),
        Behavior::SendAndHold(b"{\"ok\":true}\r\nnot part of the answer".to_vec()),
    );
    let start = Instant::now();
    assert_eq!(
        ask(&dir.socket(), &json!({"cmd": "list"})),
        Ok(json!({"ok": true}))
    );
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "{:?}",
        start.elapsed()
    );
}

#[test]
fn a_long_answer_is_read_to_the_end() {
    let reply = json!({"ok": true, "log": ["x".repeat(200_000)]});
    let dir = TestDir::new();
    let _plugin = FakePlugin::start(&dir.socket(), Behavior::json(&reply));
    assert_eq!(ask(&dir.socket(), &json!({"cmd": "status"})), Ok(reply));
}

//! The caller's request: what is refused before the socket is touched.

use std::time::Duration;

use wfinfo_overlay::{Command, DEFAULT_TIMEOUT_MS, Kind, MAX_TIMEOUT_MS, Request, Target, Window};

#[test]
fn defaults() {
    let request = Request::parse(r#"{"cmd":"list"}"#).expect("valid");
    assert_eq!(
        request,
        Request {
            command: Command::List,
            refresh: true,
            socket: None,
            timeout: Duration::from_millis(DEFAULT_TIMEOUT_MS),
        }
    );
}

#[test]
fn every_option() {
    let request = Request::parse(
        r#"{"cmd":"unpin","window":"all","refresh":false,"socket":"/x/p.sock","timeoutMs":60000}"#,
    )
    .expect("valid");
    assert_eq!(request.command, Command::Unpin(Target::All));
    assert!(!request.refresh);
    assert_eq!(request.socket.as_deref(), Some("/x/p.sock".as_ref()));
    assert_eq!(request.timeout, Duration::from_millis(MAX_TIMEOUT_MS));
}

#[test]
fn null_means_not_given() {
    let request =
        Request::parse(r#"{"cmd":"status","window":null,"refresh":null}"#).expect("valid");
    assert_eq!(request.command, Command::Status);
    assert!(request.refresh);
}

#[test]
fn toggle_takes_one_window() {
    let request = Request::parse(r#"{"cmd":"toggle","window":"timer"}"#).expect("valid");
    assert_eq!(request.command, Command::Toggle(Window::Timer));
}

#[test]
fn an_unknown_window_names_the_known_ones() {
    for window in ["map", "Browser", " browser", ""] {
        let json = format!(r#"{{"cmd":"pin","window":"{window}"}}"#);
        let error = Request::parse(&json).expect_err(&json);
        assert_eq!(error.kind, Kind::UnknownWindow, "{json}");
        assert!(
            error
                .message
                .contains("notes, browser, achievements, timer, guides, discussions, all"),
            "{error}"
        );
    }
}

#[test]
fn bad_requests_say_what_is_wrong() {
    for (json, why) in [
        ("", "bad request JSON"),
        ("list", "bad request JSON"),
        ("[]", "bad request JSON"),
        ("{}", "missing field `cmd`"),
        (r#"{"cmd":1}"#, "bad request JSON"),
        (r#"{"cmd":"list","timeout":5}"#, "unknown field `timeout`"),
        (r#"{"cmd":"reboot"}"#, "unknown command \"reboot\""),
        (r#"{"cmd":"reboot","window":"browser"}"#, "unknown command"),
        (r#"{"cmd":"list","window":"browser"}"#, "takes no window"),
        (r#"{"cmd":"status","window":"all"}"#, "takes no window"),
        (r#"{"cmd":"pin"}"#, "needs a \"window\""),
        (r#"{"cmd":"unpin"}"#, "needs a \"window\""),
        (r#"{"cmd":"toggle"}"#, "needs a \"window\""),
        (r#"{"cmd":"toggle","window":"all"}"#, "not \"all\""),
        (r#"{"cmd":"list","timeoutMs":0}"#, "from 1 to 60000"),
        (r#"{"cmd":"list","timeoutMs":60001}"#, "from 1 to 60000"),
        (r#"{"cmd":"list","timeoutMs":-1}"#, "bad request JSON"),
        (r#"{"cmd":"list","refresh":"no"}"#, "bad request JSON"),
        (r#"{"cmd":"list","socket":""}"#, "must not be empty"),
    ] {
        let error = Request::parse(json).expect_err(json);
        assert_eq!(error.kind, Kind::BadRequest, "{json}: {error}");
        assert!(error.message.contains(why), "{json}: {error}");
    }
}

#[test]
fn an_error_displays_as_its_message() {
    let error = Request::parse(r#"{"cmd":"list","socket":""}"#).expect_err("empty socket");
    assert_eq!(error.to_string(), error.message);
    let error: &dyn std::error::Error = &error;
    assert_eq!(error.to_string(), "\"socket\" must not be empty");
}

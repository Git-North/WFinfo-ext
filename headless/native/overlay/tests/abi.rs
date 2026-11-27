//! The C ABI and its JSON answers, as the .NET runner sees them.

mod common;

use std::ffi::{CStr, CString, c_char};
use std::process::Command;

use common::{Behavior, FakePlugin, TestDir, request_json};
use serde_json::{Value, json};
use wfinfo_overlay::{Kind, handle, wfinfo_overlay, wfinfo_overlay_free};

/// Calls the C function the way the runner does, and frees the answer.
fn through_c(request: Option<&[u8]>) -> Value {
    let request = request.map(|bytes| CString::new(bytes).expect("no NUL"));
    let pointer = request
        .as_ref()
        .map_or(std::ptr::null(), |text| text.as_ptr());
    // SAFETY: `pointer` is null or points into `request`, which lives to the
    // end of this function.
    let answer: *mut c_char = unsafe { wfinfo_overlay(pointer) };
    assert!(!answer.is_null());
    // SAFETY: a non-null answer is a NUL-terminated string until it is freed.
    let text = unsafe { CStr::from_ptr(answer) }
        .to_str()
        .expect("UTF-8")
        .to_owned();
    // SAFETY: the pointer came from `wfinfo_overlay` and is freed only here.
    unsafe { wfinfo_overlay_free(answer) };
    serde_json::from_str(&text).expect("a JSON answer")
}

#[track_caller]
fn assert_failure(answer: &Value, kind: Kind) {
    let code = kind.code();
    assert_eq!(answer["ok"], false, "{answer}");
    assert_eq!(answer["error"]["code"], code.code.as_str(), "{answer}");
    assert_eq!(answer["error"]["name"], code.name, "{answer}");
    let message = answer["error"]["message"].as_str().expect("a message");
    assert_ne!(message, "");
}

#[test]
fn a_success_wraps_the_plugin_answer() {
    let dir = TestDir::new();
    let reply = json!({"ok": true, "overlayOpen": false, "windows": []});
    let _plugin = FakePlugin::start(&dir.socket(), Behavior::json(&reply));
    let request = request_json(&dir.socket(), &json!({"cmd": "list"}));
    assert_eq!(
        through_c(Some(request.as_bytes())),
        json!({"ok": true, "reply": reply})
    );
}

#[test]
fn a_failure_has_code_name_and_message() {
    let dir = TestDir::new();
    let request = request_json(&dir.socket(), &json!({"cmd": "list"}));
    let answer = through_c(Some(request.as_bytes()));
    assert_failure(&answer, Kind::SocketMissing);
    assert_eq!(answer["error"]["code"], "PLG-001");
    assert_eq!(answer.get("reply"), None);
    let keys: Vec<&String> = answer["error"]
        .as_object()
        .expect("object")
        .keys()
        .collect();
    assert_eq!(keys, ["code", "message", "name"]);
}

#[test]
fn a_plugin_failure_keeps_its_reply() {
    let dir = TestDir::new();
    let reply = json!({"ok": false, "error": "no browser window is open; open it once in the overlay (Shift+Tab)"});
    let _plugin = FakePlugin::start(&dir.socket(), Behavior::json(&reply));
    let answer = handle(&request_json(
        &dir.socket(),
        &json!({"cmd": "pin", "window": "browser"}),
    ));
    let answer: Value = serde_json::from_str(&answer).expect("JSON");
    assert_failure(&answer, Kind::WindowNotOpen);
    assert_eq!(answer["reply"], reply);
}

#[test]
fn bad_input_pointers_and_bytes_are_answered() {
    assert_failure(&through_c(None), Kind::BadRequest);
    assert_failure(&through_c(Some(&[0xff, 0xfe])), Kind::BadRequest);
    assert_failure(&through_c(Some(b"")), Kind::BadRequest);
    assert_failure(
        &through_c(Some(br#"{"cmd":"pin","window":"map"}"#)),
        Kind::UnknownWindow,
    );
}

#[test]
fn freeing_null_does_nothing() {
    // SAFETY: null is allowed.
    unsafe { wfinfo_overlay_free(std::ptr::null_mut()) };
}

/// The home folder these tests expect to see as `~`.
fn home() -> Option<String> {
    let name = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(name).ok().filter(|home| home.len() > 1)
}

#[test]
fn a_failure_writes_the_home_folder_as_a_tilde() {
    let Some(home) = home() else { return };
    // Nothing exists there, so nothing is connected.
    let socket = format!("{home}/wfinfo-overlay-no-such-folder/p.sock");
    let answer = handle(&json!({"cmd": "list", "socket": socket}).to_string());
    assert!(!answer.contains(&home), "{answer}");
    assert!(
        answer.contains("~/wfinfo-overlay-no-such-folder/p.sock"),
        "{answer}"
    );
}

#[test]
fn a_name_that_only_starts_like_the_home_folder_stays() {
    let Some(home) = home() else { return };
    let socket = format!("{home}x-wfinfo-overlay-no-such-folder/p.sock");
    let answer = handle(&json!({"cmd": "list", "socket": socket}).to_string());
    let answer: Value = serde_json::from_str(&answer).expect("JSON");
    let message = answer["error"]["message"].as_str().expect("message");
    assert!(message.contains(&socket), "{message}");
}

#[test]
fn what_the_plugin_says_is_redacted_too() {
    let Some(home) = home() else { return };
    let file = format!("{home}/plugins/cli_socket.lua");
    let reply = json!({
        "ok": false, "error": format!("backend: {file}:7: boom"),
        "log": [file, {"at": home}], "n": 3,
    });
    let dir = TestDir::new();
    let _plugin = FakePlugin::start(&dir.socket(), Behavior::json(&reply));
    let answer = handle(&request_json(&dir.socket(), &json!({"cmd": "status"})));
    assert!(!answer.contains(&home), "{answer}");
    let answer: Value = serde_json::from_str(&answer).expect("JSON");
    assert_eq!(
        answer["reply"]["log"],
        json!(["~/plugins/cli_socket.lua", {"at": "~"}])
    );
    assert_eq!(answer["reply"]["n"], 3);

    // An unreadable answer is quoted in the message: redacted before it is cut.
    let dir = TestDir::new();
    let garbage = format!("{}{home}/x", "g".repeat(195));
    let _plugin = FakePlugin::start(&dir.socket(), Behavior::line(&garbage));
    let answer = handle(&request_json(&dir.socket(), &json!({"cmd": "list"})));
    assert!(answer.contains("~/x"), "{answer}");
}

/// Runs one test of this binary again with only the given environment (plus
/// what a coverage run needs). The environment of a running test process
/// cannot change safely.
fn run_in_child(test: &str, expected: &str, variables: &[(&str, &str)]) {
    let output = Command::new(std::env::current_exe().expect("test binary"))
        .args(["--exact", test])
        .env_clear()
        .envs(std::env::var_os("LLVM_PROFILE_FILE").map(|file| ("LLVM_PROFILE_FILE", file)))
        .env(CHILD, expected)
        .envs(variables.iter().copied())
        .output()
        .expect("run the test binary");
    let report = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{report}");
    assert!(report.contains("1 passed"), "{report}");
}

/// Set in a child run; holds what its answer must contain.
const CHILD: &str = "WFINFO_OVERLAY_TEST_CHILD";

/// `call` without a `socket` reads the environment. The real default path may
/// be a running plugin, so only a made-up environment is used.
#[test]
fn without_a_socket_the_environment_gives_the_path() {
    const TEST: &str = "without_a_socket_the_environment_gives_the_path";
    if let Ok(expected) = std::env::var(CHILD) {
        let answer = handle(r#"{"cmd":"list","timeoutMs":2000}"#);
        assert!(answer.contains(&expected), "{answer}");
        return;
    }
    // The override reaches a fake plugin.
    let dir = TestDir::new();
    let plugin = FakePlugin::start(&dir.socket(), Behavior::line(r#"{"ok":true}"#));
    let socket = dir.socket();
    run_in_child(
        TEST,
        r#""ok":true"#,
        &[(
            wfinfo_overlay::SOCKET_VARIABLE,
            socket.to_str().expect("UTF-8"),
        )],
    );
    assert_eq!(plugin.requests(), ["{\"cmd\":\"list\"}\n"]);
    // No variable at all: there is no path to try.
    run_in_child(TEST, "PLG-013", &[]);
}

#[test]
fn a_windows_home_folder_is_redacted_also_inside_json_text() {
    const TEST: &str = "a_windows_home_folder_is_redacted_also_inside_json_text";
    if std::env::var_os(CHILD).is_some() {
        let dir = TestDir::new();
        // A bad answer that quotes the folder as JSON text does.
        let _plugin = FakePlugin::start(
            &dir.socket(),
            Behavior::line(r#"{"at": "C:\\Users\\someone\\plugin.lua""#),
        );
        let answer = handle(&request_json(&dir.socket(), &json!({"cmd": "list"})));
        assert!(answer.contains("PLG-005"), "{answer}");
        assert!(!answer.contains("someone"), "{answer}");
        let socket = r"C:\Users\someone\no-such-folder\p.sock";
        let answer = handle(&json!({"cmd": "list", "socket": socket}).to_string());
        assert!(!answer.contains("someone"), "{answer}");
        return;
    }
    // TMPDIR: where the child makes its socket.
    let temp = std::env::temp_dir();
    run_in_child(
        TEST,
        "unused",
        &[
            ("USERPROFILE", r"C:\Users\someone\"),
            ("TMPDIR", temp.to_str().expect("UTF-8")),
        ],
    );
}

#[test]
fn a_bare_root_as_home_hides_nothing() {
    const TEST: &str = "a_bare_root_as_home_hides_nothing";
    if let Ok(expected) = std::env::var(CHILD) {
        let answer = handle(r#"{"cmd":"list","socket":"/no-such-folder/p.sock"}"#);
        assert!(answer.contains(&expected), "{answer}");
        return;
    }
    for home in ["/", "", "C:\\"] {
        run_in_child(TEST, "at /no-such-folder/p.sock", &[("HOME", home)]);
    }
}

//! The per-OS socket path rules, which must match the plugin's.

use std::ffi::OsString;
use std::path::PathBuf;

use wfinfo_overlay::{Os, SOCKET_VARIABLE, socket_path};

fn path(os: Os, env: &[(&str, &str)]) -> Result<PathBuf, &'static str> {
    socket_path(os, |name| {
        env.iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| OsString::from(value))
    })
}

const OS: [Os; 3] = [Os::MacOs, Os::Windows, Os::Unix];

#[test]
fn the_override_wins_everywhere() {
    for os in OS {
        let env = [
            (SOCKET_VARIABLE, "/elsewhere/s.sock"),
            ("HOME", "/home/u"),
            ("XDG_RUNTIME_DIR", "/run/user/1"),
            ("LOCALAPPDATA", "C:/Local"),
        ];
        assert_eq!(
            path(os, &env),
            Ok(PathBuf::from("/elsewhere/s.sock")),
            "{os:?}"
        );
    }
    assert_eq!(SOCKET_VARIABLE, "OVERLAY_AUTOPIN_SOCKET");
}

#[test]
fn macos() {
    assert_eq!(
        path(
            Os::MacOs,
            &[("HOME", "/Users/u"), ("XDG_RUNTIME_DIR", "/run/x")]
        ),
        Ok(PathBuf::from(
            "/Users/u/Library/Application Support/Millennium/overlay-autopin.sock"
        ))
    );
}

#[test]
fn linux_prefers_the_runtime_directory() {
    assert_eq!(
        path(
            Os::Unix,
            &[("HOME", "/home/u"), ("XDG_RUNTIME_DIR", "/run/user/1")]
        ),
        Ok(PathBuf::from("/run/user/1/overlay-autopin.sock"))
    );
    assert_eq!(
        path(Os::Unix, &[("HOME", "/home/u"), ("XDG_RUNTIME_DIR", "")]),
        Ok(PathBuf::from(
            "/home/u/.local/share/millennium/overlay-autopin.sock"
        ))
    );
}

#[test]
fn windows() {
    let expected = PathBuf::from("C:/Local")
        .join("Millennium")
        .join("overlay-autopin.sock");
    assert_eq!(
        path(Os::Windows, &[("LOCALAPPDATA", "C:/Local")]),
        Ok(expected)
    );
}

#[test]
fn missing_variables_are_named() {
    for (os, why) in [
        (Os::MacOs, "HOME is not set"),
        (Os::Windows, "LOCALAPPDATA is not set"),
        (Os::Unix, "neither XDG_RUNTIME_DIR nor HOME is set"),
    ] {
        assert_eq!(path(os, &[("HOME", ""), (SOCKET_VARIABLE, "")]), Err(why));
    }
}

#[test]
fn this_build_knows_its_os() {
    let expected = if cfg!(target_os = "macos") {
        Os::MacOs
    } else if cfg!(windows) {
        Os::Windows
    } else {
        Os::Unix
    };
    assert_eq!(Os::current(), expected);
}

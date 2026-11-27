//! The C ABI the .NET runner calls through `[DllImport]`.

use std::ffi::{CStr, CString, c_char};
use std::panic::{self, AssertUnwindSafe};
use std::ptr;

use crate::answer::Failure;
use crate::error::{Error, Kind};

/// Runs one request (NUL-terminated UTF-8 JSON) and returns the answer as
/// NUL-terminated UTF-8 JSON, to free with [`wfinfo_overlay_free`]. See the
/// crate documentation for both shapes. The call blocks for at most the
/// request's `timeoutMs`. It never unwinds into the caller. It returns null
/// only when it cannot build the answer string.
///
/// # Safety
/// `request` must be null or point to a NUL-terminated string that stays
/// valid and unchanged for the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wfinfo_overlay(request: *const c_char) -> *mut c_char {
    let text = if request.is_null() {
        None
    } else {
        // SAFETY: not null, so by this function's contract a valid
        // NUL-terminated string that outlives the call.
        Some(unsafe { CStr::from_ptr(request) }.to_bytes())
    };
    into_c_string(guarded(|| match text.map(std::str::from_utf8) {
        Some(Ok(json)) => crate::handle(json),
        Some(Err(_)) => failure(Kind::BadRequest, "the request is not UTF-8"),
        None => failure(Kind::BadRequest, "the request pointer is null"),
    }))
}

/// Frees a string [`wfinfo_overlay`] returned. Null is ignored.
///
/// # Safety
/// `answer` must be null or a pointer that `wfinfo_overlay` returned and that
/// has not been freed yet.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wfinfo_overlay_free(answer: *mut c_char) {
    if !answer.is_null() {
        // SAFETY: not null, so by this function's contract it came from
        // `CString::into_raw` in `wfinfo_overlay` and is freed only once.
        drop(unsafe { CString::from_raw(answer) });
    }
}

fn failure(kind: Kind, message: &str) -> String {
    crate::failure_json(&Failure::from(Error::new(kind, message)))
}

/// Runs `work` and turns a panic into an `internal error` answer.
fn guarded(work: impl FnOnce() -> String) -> String {
    panic::catch_unwind(AssertUnwindSafe(work)).unwrap_or_else(|payload| {
        // `panic!` carries a `&str` or a `String`.
        let reason = payload
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
            .unwrap_or("no reason given");
        failure(
            Kind::Internal,
            &format!("internal error in the overlay client: {reason}"),
        )
    })
}

/// JSON text escapes control characters, so it holds no NUL byte.
fn into_c_string(text: String) -> *mut c_char {
    CString::new(text).map_or(ptr::null_mut(), CString::into_raw)
}

#[cfg(test)]
mod tests {
    // The only unit test: no request can make the library panic, so the guard
    // is only reachable from inside. Everything else is tested in `tests/`.
    #[test]
    fn a_panic_becomes_an_answer() {
        // A formatted message, like most real panics.
        let what = "boom";
        let answer = super::guarded(|| panic!("{what}"));
        let answer: serde_json::Value = serde_json::from_str(&answer).expect("JSON");
        assert_eq!(answer["ok"], false);
        let expected = crate::generated(crate::PANIC_INPUT);
        assert_eq!(answer["error"]["code"], expected.code.as_str());
        assert_eq!(answer["error"]["name"], expected.name);
        assert_eq!(
            answer["error"]["message"],
            "internal error in the overlay client: boom"
        );
    }

    #[test]
    fn a_panic_with_another_payload_is_answered_too() {
        let answer = super::guarded(|| std::panic::panic_any(7));
        assert!(answer.contains("no reason given"), "{answer}");
    }
}

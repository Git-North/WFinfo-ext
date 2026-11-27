//! WFInfo macOS reward layout.
//!
//! `wfinfo-mac rewards` reads text from a reward screen with Apple Vision and
//! prints lines with boxes. This library keeps the lines that sit in WFInfo's
//! name rows, groups them into reward slots and joins wrapped names. The C#
//! runner (`VisionRewardScan.cs`) calls it through two C functions:
//!
//! - `wfinfo_layout(const char *json) -> char *`: JSON in, JSON out. The input
//!   has `helper` (the `rewards` JSON), `rewardWidth`, `rewardHeight`,
//!   `rewardY` and `lineHeight` (WFInfo's OCR constants). The output has
//!   `uiScale`, `uiScaleEstimated`, `screenScaling`, `rowTop`, `rowBottom`,
//!   `slots[]` (`centerX`, `gridX`, `lines`, `candidates`, `otherLines`),
//!   `notes` and `scaleScores`. On failure it is
//!   `{"error": {"code": "LAY-001" | "LAY-002", "message": "..."}}` (codes in
//!   errors/catalog.json): LAY-001 when `helper` is missing, null, not an
//!   object, or lacks `width`, `height` or `lines`; LAY-002 for anything else
//!   (bad JSON, missing constants, non-UTF-8 or null input, a caught panic).
//! - `wfinfo_layout_free(char *)`: frees a string `wfinfo_layout` returned.

mod dotnet;
mod layout;
mod letters;

use layout::{LayoutLine, RewardLayoutResult, RewardSlot, analyze, parse_lines};
use serde::Deserialize;
use serde_json::{Value, json};
use std::ffi::{CStr, CString, c_char};
use std::panic::catch_unwind;
use std::ptr;

#[derive(Deserialize)]
struct Input {
    #[serde(default)]
    helper: Value,
    #[serde(rename = "rewardWidth")]
    reward_width: i32,
    #[serde(rename = "rewardHeight")]
    reward_height: i32,
    #[serde(rename = "rewardY")]
    reward_y: i32,
    #[serde(rename = "lineHeight")]
    line_height: i32,
}

fn line_json(l: &LayoutLine) -> Value {
    json!({
        "text": l.text,
        "confidence": l.confidence,
        "box": { "x": l.bx.x, "y": l.bx.y, "width": l.bx.width, "height": l.bx.height },
    })
}

fn slot_json(s: &RewardSlot<'_>) -> Value {
    json!({
        "centerX": s.center_x,
        "gridX": s.grid_x,
        "lines": s.lines.iter().map(|l| line_json(l)).collect::<Vec<_>>(),
        "candidates": s.candidates,
        "otherLines": s.other_lines.iter().map(|l| line_json(l)).collect::<Vec<_>>(),
    })
}

fn result_json(r: &RewardLayoutResult<'_>) -> Value {
    json!({
        "uiScale": r.ui_scale,
        "uiScaleEstimated": r.ui_scale_estimated,
        "screenScaling": r.screen_scaling,
        "rowTop": r.row_top,
        "rowBottom": r.row_bottom,
        "slots": r.slots.iter().map(slot_json).collect::<Vec<_>>(),
        "notes": r.notes,
        "scaleScores": r.scale_scores.iter()
            .map(|x| json!({ "uiScale": x.ui_scale, "score": x.score }))
            .collect::<Vec<_>>(),
    })
}

/// Catalog code: the helper answer is missing or has no fields to lay out.
pub const INPUT_INVALID: &str = "LAY-001";
/// Catalog code: any other layout failure.
pub const LAYOUT_FAILED: &str = "LAY-002";

fn error_json(code: &str, message: &str) -> String {
    json!({ "error": { "code": code, "message": message } }).to_string()
}

/// Why `helper` cannot be laid out, or `None` when it has the needed fields.
/// Present fields with odd values (a negative width) are not an error: the
/// layout answers them with a note, as the C# version did.
fn helper_problem(helper: Option<&Value>) -> Option<String> {
    let object = match helper {
        None => return Some("no helper answer in the input".to_string()),
        Some(Value::Null) => return Some("the helper answer is null".to_string()),
        Some(Value::Object(object)) => object,
        Some(_) => return Some("the helper answer is not a JSON object".to_string()),
    };
    let missing: Vec<&str> = ["width", "height", "lines"]
        .into_iter()
        .filter(|key| !object.contains_key(*key))
        .collect();
    if missing.is_empty() {
        return None;
    }
    let mut message = format!("the helper answer has no {}", missing.join(", "));
    if let Some(error) = object.get("error").and_then(Value::as_str) {
        message.push_str(&format!(" (helper error: {error})"));
    }
    Some(message)
}

/// The whole step on UTF-8 JSON text: the C ABI is a thin shell around this.
pub fn layout_json(input: &str) -> String {
    let value: Value = match serde_json::from_str(input) {
        Ok(value) => value,
        Err(e) => return error_json(LAYOUT_FAILED, &format!("bad input: {e}")),
    };
    if let Some(problem) = helper_problem(value.get("helper")) {
        return error_json(INPUT_INVALID, &problem);
    }
    let input: Input = match serde_json::from_value(value) {
        Ok(input) => input,
        Err(e) => return error_json(LAYOUT_FAILED, &format!("bad input: {e}")),
    };
    let lines = parse_lines(input.helper.get("lines"));
    let result = analyze(
        &input.helper,
        &lines,
        input.reward_width,
        input.reward_height,
        input.reward_y,
        input.line_height,
    );
    result_json(&result).to_string()
}

fn into_c_string(text: String) -> *mut c_char {
    CString::new(text).map_or(ptr::null_mut(), CString::into_raw)
}

/// Runs the layout on a NUL-terminated UTF-8 JSON string and returns a
/// NUL-terminated UTF-8 JSON string, to free with [`wfinfo_layout_free`].
/// Returns null only when it cannot allocate the answer.
///
/// # Safety
/// `json` must be null or point to a NUL-terminated string that stays valid
/// for the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wfinfo_layout(json: *const c_char) -> *mut c_char {
    let answer = catch_unwind(|| {
        if json.is_null() {
            return error_json(LAYOUT_FAILED, "null input");
        }
        // SAFETY: the caller promises a valid NUL-terminated string (see above).
        let bytes = unsafe { CStr::from_ptr(json) }.to_bytes();
        match std::str::from_utf8(bytes) {
            Ok(text) => layout_json(text),
            Err(_) => error_json(LAYOUT_FAILED, "input is not UTF-8"),
        }
    })
    .unwrap_or_else(|_| error_json(LAYOUT_FAILED, "internal error (panic)"));
    into_c_string(answer)
}

/// Frees a string returned by [`wfinfo_layout`]. Null is ignored.
///
/// # Safety
/// `text` must be null or a pointer returned by `wfinfo_layout` that has not
/// been freed yet.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wfinfo_layout_free(text: *mut c_char) {
    if !text.is_null() {
        // SAFETY: the pointer came from `CString::into_raw` in `wfinfo_layout`
        // and the caller frees it once.
        drop(unsafe { CString::from_raw(text) });
    }
}

#[cfg(test)]
mod tests;

//! The crate's codes against errors/catalog.json, the one list both must
//! follow.

use std::collections::HashSet;
use std::path::PathBuf;

use serde_json::Value;
use wfinfo_overlay::{Kind, PANIC_INPUT, WORDS, fnv1a32, generated};

fn repository_file(path: &str) -> String {
    let full = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(path);
    std::fs::read_to_string(&full).unwrap_or_else(|e| panic!("read {}: {e}", full.display()))
}

fn catalog() -> Value {
    serde_json::from_str(&repository_file("errors/catalog.json")).expect("valid JSON")
}

fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value[field]
        .as_str()
        .unwrap_or_else(|| panic!("{field} in {value}"))
}

fn entries(catalog: &Value) -> &Vec<Value> {
    catalog["errors"].as_array().expect("errors")
}

/// The wrapper reports the two failures that mean there is no library to ask.
const WRAPPER_CODES: [&str; 2] = ["PLG-019", "PLG-020"];

#[test]
fn codes_and_names_are_unique_and_every_area_is_known() {
    let catalog = catalog();
    let mut codes = HashSet::new();
    let mut names = HashSet::new();
    for entry in entries(&catalog) {
        assert!(codes.insert(text(entry, "code")), "{entry}");
        assert!(names.insert(text(entry, "name")), "{entry}");
        assert!(
            catalog["areas"].get(text(entry, "area")).is_some(),
            "{entry}"
        );
        assert!(
            ["error", "warning", "info"].contains(&text(entry, "severity")),
            "{entry}"
        );
        for field in ["title", "description", "action"] {
            assert_ne!(text(entry, field), "", "{entry}");
        }
    }
}

#[test]
fn every_kind_has_its_own_catalog_entry() {
    let catalog = catalog();
    let mut used = HashSet::new();
    for kind in Kind::ALL.into_iter().filter(|&kind| kind != Kind::Internal) {
        let code = kind.code();
        let entry = entries(&catalog)
            .iter()
            .find(|entry| text(entry, "code") == code.code)
            .unwrap_or_else(|| panic!("{kind:?}: no {} in the catalog", code.code));
        assert_eq!(text(entry, "name"), code.name, "{kind:?}");
        assert_eq!(text(entry, "area"), "PLG", "{kind:?}");
        assert!(used.insert(code.code), "{kind:?} shares a code");
    }
}

#[test]
fn every_plg_entry_is_reported_by_the_crate_or_the_wrapper() {
    let catalog = catalog();
    let wrapper = repository_file("headless/OverlayPin.cs");
    let of_kinds: HashSet<String> = Kind::ALL.into_iter().map(|kind| kind.code().code).collect();
    let mut count = 0;
    for entry in entries(&catalog) {
        let (code, name) = (text(entry, "code"), text(entry, "name"));
        if !code.starts_with("PLG-") {
            continue;
        }
        count += 1;
        if WRAPPER_CODES.contains(&code) {
            assert!(
                wrapper.contains(&format!("\"{code}\", \"{name}\"")),
                "OverlayPin.cs must report {code} {name}"
            );
        } else {
            assert!(of_kinds.contains(code), "nothing reports {code}");
        }
    }
    assert_eq!(count, Kind::ALL.len() - 1 + WRAPPER_CODES.len());
}

#[test]
fn kind_all_lists_each_kind_once() {
    for (i, kind) in Kind::ALL.iter().enumerate() {
        assert!(!Kind::ALL[i + 1..].contains(kind), "{kind:?}");
    }
}

#[test]
fn generated_codes_follow_the_catalog() {
    let catalog = catalog();
    let rule = &catalog["generated"];
    let words: Vec<&str> = rule["words"]
        .as_array()
        .expect("words")
        .iter()
        .map(|word| word.as_str().expect("a word"))
        .collect();
    assert_eq!(words, WORDS);
    let vectors = rule["testVectors"].as_array().expect("testVectors");
    assert_ne!(vectors.len(), 0);
    for vector in vectors {
        let input = text(vector, "input");
        assert_eq!(
            format!("{:08x}", fnv1a32(input.as_bytes())),
            text(vector, "hash")
        );
        let code = generated(input);
        assert_eq!(code.code, text(vector, "code"));
        assert_eq!(code.name, text(vector, "name"));
    }
    assert_eq!(Kind::Internal.code(), generated(PANIC_INPUT));
}

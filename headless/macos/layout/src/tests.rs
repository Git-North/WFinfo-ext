//! The eight reward-layout cases of the C# self-test this crate replaces
//! (hand-written fixtures in the `wfinfo-mac rewards` JSON shape), plus checks
//! of the C ABI. The fixture boxes follow WFInfo's geometry (1080p units times
//! su = s*u): name glyphs 17 tall, line advance 20, first line top 4 below the
//! row top; squad names 14 tall, 4 below the row bottom; "1 OWNED" 14 tall,
//! 60 above the row top.

use super::*;
use std::ffi::CString;

// OCR.pixleRewardWidth, pixleRewardHeight, pixleRewardYDisplay, pixelRewardLineHeight.
const REWARD_WIDTH: i32 = 968;
const REWARD_HEIGHT: i32 = 235;
const REWARD_Y: i32 = 316;
const LINE_HEIGHT: i32 = 48;

struct Fixture {
    w: f64,
    h: f64,
    s: f64,
    u: f64,
    known: bool,
    lines: Vec<Value>,
}

impl Fixture {
    fn new(w: f64, h: f64, u: f64, known: bool) -> Self {
        Fixture {
            w,
            h,
            s: (w / 1920.0).min(h / 1080.0),
            u,
            known,
            lines: Vec::new(),
        }
    }
    fn su(&self) -> f64 {
        self.s * self.u
    }
    fn row_top(&self) -> f64 {
        self.h / 2.0 - f64::from(REWARD_Y - REWARD_HEIGHT + LINE_HEIGHT) * self.su()
    }
    fn row_bottom(&self) -> f64 {
        self.h / 2.0 - f64::from(REWARD_Y - REWARD_HEIGHT) * self.su()
    }
    fn slot_x(&self, i: usize, n: usize) -> f64 {
        self.w / 2.0
            + (i as f64 - (n as f64 - 1.0) / 2.0) * (f64::from(REWARD_WIDTH) / 4.0) * self.su()
    }
    fn name(&mut self, i: usize, n: usize, rows: &[&str]) {
        for (k, row) in rows.iter().enumerate() {
            let su = self.su();
            let top = self.row_top() + (4.0 + 20.0 * k as f64) * su;
            self.add(row, self.slot_x(i, n), top, 17.0 * su, None);
        }
    }
    fn squad(&mut self, i: usize, n: usize, text: &str) {
        let su = self.su();
        self.add(
            text,
            self.slot_x(i, n),
            self.row_bottom() + 4.0 * su,
            14.0 * su,
            None,
        );
    }
    fn owned(&mut self, i: usize, n: usize, text: &str) {
        let su = self.su();
        self.add(
            text,
            self.slot_x(i, n) - 60.0 * su,
            self.row_top() - 60.0 * su,
            14.0 * su,
            None,
        );
    }
    /// "1 OWNED" header just above the rows: its centre is 11.5*su over the row
    /// top, inside the band tolerance (L/4 = 12*su), so the in-band filter keeps
    /// it and only the header-group rule can drop it. Its gap to the name
    /// (8.5*su) is just over 0.6 of the median line height (14*su).
    fn owned_in_band(&mut self, i: usize, n: usize, text: &str) {
        let su = self.su();
        let top = self.row_top() - 18.5 * su;
        self.add(text, self.slot_x(i, n) - 60.0 * su, top, 14.0 * su, None);
    }
    fn add(&mut self, text: &str, centre_x: f64, top: f64, height: f64, width: Option<f64>) {
        let wd = width.unwrap_or_else(|| {
            (230.0 * self.su()).min(text.chars().count() as f64 * 9.0 * self.su())
        });
        self.lines.push(json!({
            "text": text,
            "confidence": 0.9,
            "box": { "x": centre_x - wd / 2.0, "y": top, "width": wd, "height": height },
        }));
    }

    fn input(&self) -> Value {
        let crop_h = 200.0 * self.s * 1.25;
        let (lo, hi) = if self.known {
            (self.u, self.u)
        } else {
            (0.5, 1.25)
        };
        json!({
            "helper": {
                "source": "fixture",
                "width": self.w,
                "height": self.h,
                "screenScaling": self.s,
                "uiScaleMin": lo,
                "uiScaleMax": hi,
                "crop": {
                    "x": self.w / 2.0 - f64::from(REWARD_WIDTH) * self.s * 1.25 / 2.0,
                    "y": self.h / 2.0 - crop_h,
                    "width": f64::from(REWARD_WIDTH) * self.s * 1.25,
                    "height": crop_h,
                },
                "lines": self.lines,
            },
            "rewardWidth": REWARD_WIDTH,
            "rewardHeight": REWARD_HEIGHT,
            "rewardY": REWARD_Y,
            "lineHeight": LINE_HEIGHT,
        })
    }

    fn analyze(&self) -> Value {
        let out = layout_json(&self.input().to_string());
        serde_json::from_str(&out).expect("the layout answers with JSON")
    }
}

fn candidates(v: &Value, slot: usize) -> Vec<String> {
    v["slots"][slot]["candidates"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|c| c.as_str().unwrap_or("").to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn notes(v: &Value) -> Vec<String> {
    v["notes"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|n| n.as_str().unwrap_or("").to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// First candidate of every slot must equal `firsts`; slots run left to right.
fn expect(f: &Fixture, firsts: &[&str]) {
    let v = f.analyze();
    let slots = v["slots"].as_array().expect("slots");
    let got: Vec<String> = (0..slots.len())
        .map(|i| candidates(&v, i).first().cloned().unwrap_or_default())
        .collect();
    assert_eq!(got, firsts, "u={}, notes: {:?}", v["uiScale"], notes(&v));
    for pair in slots.windows(2) {
        assert!(
            pair[1]["centerX"].as_f64() > pair[0]["centerX"].as_f64(),
            "slots not left to right"
        );
    }
}

fn expect_scale(f: &Fixture, u: f64) {
    let got = f.analyze()["uiScale"].as_f64().expect("uiScale");
    assert!((got - u).abs() < 0.026, "ui scale {got}, expected {u}");
}

#[test]
fn case_a_four_slots_known_scale_wrapped_name_squad_and_owned() {
    let mut f = Fixture::new(1920.0, 1080.0, 1.0, true);
    let names: [&[&str]; 4] = [
        &["Forma Blueprint"],
        &["Lex Prime Receiver"],
        &["Nikana Prime", "Blueprint"],
        &["Akstiletto Prime Barrel"],
    ];
    let squad = ["TennoOne", "xXSlayerXx", "Moonlit", "Ordis42"];
    for (i, rows) in names.iter().enumerate() {
        f.name(i, 4, rows);
        f.squad(i, 4, squad[i]);
        if i != 1 {
            f.owned_in_band(i, 4, "1 OWNED");
        }
    }
    // The header is inside the band, so it reaches the grouping step: it must
    // come back as an "other" line of its slot (dropped by the header-group
    // rule), never as part of a name.
    let v = f.analyze();
    for (slot, owned) in [(0, true), (1, false), (2, true), (3, true)] {
        let others: Vec<&str> = v["slots"][slot]["otherLines"]
            .as_array()
            .expect("otherLines")
            .iter()
            .filter_map(|l| l["text"].as_str())
            .collect();
        assert_eq!(
            others.contains(&"1 OWNED"),
            owned,
            "slot {slot}: {others:?}"
        );
        assert!(
            !candidates(&v, slot).iter().any(|c| c.contains("OWNED")),
            "slot {slot}: the header leaked into a name"
        );
    }
    expect(
        &f,
        &[
            "Forma Blueprint",
            "Lex Prime Receiver",
            "Nikana Prime Blueprint",
            "Akstiletto Prime Barrel",
        ],
    );
    assert_eq!(
        candidates(&f.analyze(), 2).get(1).map(String::as_str),
        Some("Nikana Prime")
    );
}

#[test]
fn case_b_three_slots_1440p_unknown_scale() {
    let mut f = Fixture::new(2560.0, 1440.0, 0.8, false);
    let names: [&[&str]; 3] = [
        &["Saryn Prime", "Chassis Blueprint"],
        &["Braton Prime Stock"],
        &["Forma Blueprint"],
    ];
    for (i, rows) in names.iter().enumerate() {
        f.name(i, 3, rows);
        f.squad(i, 3, &format!("Squadmate{}", i + 1));
        f.owned(i, 3, &format!("{} OWNED", i + 2));
    }
    expect(
        &f,
        &[
            "Saryn Prime Chassis Blueprint",
            "Braton Prime Stock",
            "Forma Blueprint",
        ],
    );
    expect_scale(&f, 0.8);
}

#[test]
fn case_c_two_slots_ultrawide_unknown_scale() {
    let mut f = Fixture::new(3440.0, 1440.0, 1.0, false);
    f.name(0, 2, &["Paris Prime String"]);
    f.name(1, 2, &["Volt Prime", "Neuroptics Blueprint"]);
    f.squad(0, 2, "Hunter");
    f.squad(1, 2, "Gatherer");
    expect(
        &f,
        &["Paris Prime String", "Volt Prime Neuroptics Blueprint"],
    );
    expect_scale(&f, 1.0);
}

#[test]
fn case_d_one_slot_known_scale_125() {
    let mut f = Fixture::new(1728.0, 1117.0, 1.25, true);
    f.name(0, 1, &["Ash Prime Systems", "Blueprint"]);
    f.squad(0, 1, "Solo");
    f.owned(0, 1, "3 OWNED");
    expect(&f, &["Ash Prime Systems Blueprint"]);
}

#[test]
fn case_e_noise_without_letters_and_a_stray_word_outside_the_strip() {
    let mut f = Fixture::new(1920.0, 1080.0, 1.0, true);
    f.name(0, 4, &["Forma Blueprint"]);
    f.name(1, 4, &["Bronco Prime Barrel"]);
    f.name(2, 4, &["Carrier Prime Cerebrum"]);
    f.name(3, 4, &["Mag Prime Blueprint"]);
    let su = f.su();
    // No letters, on the first name row of slot 1, right of the name.
    f.add(
        "== 42 ==",
        f.slot_x(1, 4) + 100.0 * su,
        f.row_top() + 4.0 * su,
        17.0 * su,
        None,
    );
    // No letters, between the slots, inside the band.
    f.add(
        "|||",
        f.slot_x(2, 4) + 121.0 * su,
        f.row_top() + 10.0 * su,
        17.0 * su,
        None,
    );
    // A stray word far outside the strip, at the name-row height.
    f.add("Warframe", 80.0, f.row_top() + 4.0 * su, 17.0 * su, None);
    expect(
        &f,
        &[
            "Forma Blueprint",
            "Bronco Prime Barrel",
            "Carrier Prime Cerebrum",
            "Mag Prime Blueprint",
        ],
    );
}

#[test]
fn case_f_no_lines() {
    let f = Fixture::new(1920.0, 1080.0, 1.0, false);
    expect(&f, &[]);
    expect_scale(&f, 1.0);
}

#[test]
fn case_g_one_slot_unknown_scale_wrapped_name_squad() {
    let mut f = Fixture::new(1920.0, 1080.0, 0.9, false);
    f.name(0, 1, &["Rhino Prime", "Systems Blueprint"]);
    f.squad(0, 1, "Lotus");
    expect(&f, &["Rhino Prime Systems Blueprint"]);
    // An estimate of 1.0 would also give the name, so check the scale itself.
    expect_scale(&f, 0.9);
}

#[test]
fn case_h_five_columns_keep_the_four_that_fit_the_grid() {
    // Real cards sit 242*su apart, so a fifth column needs an uneven spread:
    // five texts 180 px apart. The middle one is off the 4-slot grid.
    let mut f = Fixture::new(1920.0, 1080.0, 1.0, true);
    let names = [
        "Forma Blueprint",
        "Lex Prime Barrel",
        "Burston Prime Stock",
        "Nova Prime Systems",
    ];
    let offsets = [-360.0, -180.0, 180.0, 360.0];
    for i in 0..4 {
        f.add(
            names[i],
            960.0 + offsets[i],
            f.row_top() + 4.0 * f.su(),
            17.0 * f.su(),
            Some(150.0),
        );
    }
    f.add(
        "Relic",
        960.0,
        f.row_top() + 4.0 * f.su(),
        17.0 * f.su(),
        Some(45.0),
    );
    assert!(
        notes(&f.analyze()).iter().any(|n| n.contains("Relic")),
        "no note names the extra column"
    );
    expect(&f, &names);
}

// ---- C ABI and bad input ------------------------------------------------------

#[test]
fn bad_input_gives_an_error_object() {
    for text in ["", "not json", "{}", "[1]", r#"{"rewardWidth":"x"}"#] {
        let out: Value = serde_json::from_str(&layout_json(text)).expect("JSON out");
        assert!(out["error"].is_string(), "input {text:?}");
    }
}

#[test]
fn helper_without_size_gives_a_note_and_no_slots() {
    let input = json!({"helper": {"error": "no display"}, "rewardWidth": 968, "rewardHeight": 235,
        "rewardY": 316, "lineHeight": 48});
    let out: Value = serde_json::from_str(&layout_json(&input.to_string())).expect("JSON out");
    assert_eq!(out["slots"].as_array().map(Vec::len), Some(0));
    assert_eq!(out["uiScale"].as_f64(), Some(1.0));
    assert_eq!(out["uiScaleEstimated"], Value::Bool(true));
    assert_eq!(
        notes(&out),
        [
            "helper error: no display",
            "no image size in the helper JSON"
        ]
    );
}

#[test]
fn c_abi_round_trip() {
    let mut f = Fixture::new(1920.0, 1080.0, 1.0, true);
    f.name(0, 1, &["Forma Blueprint"]);
    let input = CString::new(f.input().to_string()).expect("no NUL");
    // SAFETY: `input` is a valid NUL-terminated string; the answer is freed once.
    let text = unsafe {
        let p = wfinfo_layout(input.as_ptr());
        assert!(!p.is_null());
        let s = CStr::from_ptr(p).to_str().expect("UTF-8").to_string();
        wfinfo_layout_free(p);
        s
    };
    let out: Value = serde_json::from_str(&text).expect("JSON out");
    assert_eq!(out["slots"][0]["candidates"][0], "Forma Blueprint");
    // SAFETY: null is allowed for both functions.
    unsafe {
        let p = wfinfo_layout(ptr::null());
        assert!(!p.is_null());
        wfinfo_layout_free(p);
        wfinfo_layout_free(ptr::null_mut());
    }
}

// ---- parity with the C# version -----------------------------------------------

/// Text escape of the parity file: printable ASCII as is, anything else `\u{hex}`.
fn canon_str(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        let v = u32::from(c);
        if (0x20..0x7f).contains(&v) && c != '"' && c != '\\' {
            out.push(c);
        } else {
            out.push_str(&format!("\\u{{{v:x}}}"));
        }
    }
    out.push('"');
    out
}

/// Canonical form of an answer: keys sorted, every number as its IEEE bits.
fn canon(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .iter()
                .map(|k| format!("{}:{}", canon_str(k), canon(&m[*k])))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(a) => format!("[{}]", a.iter().map(canon).collect::<Vec<_>>().join(",")),
        Value::Number(n) => format!("\"f:{:016x}\"", n.as_f64().unwrap_or(f64::NAN).to_bits()),
        Value::Bool(b) => b.to_string(),
        Value::String(t) => canon_str(t),
        Value::Null => "null".to_string(),
    }
}

/// `testdata/parity.jsonl`: inputs and the answers the C# `RewardLayout.cs`
/// gave for them (recorded before it was deleted; doubles compared bit for
/// bit): the eight cases above with known and unknown scale, wrapped names,
/// extra columns, noise, tied x values, scale ranges that round at a tie.
#[test]
fn answers_equal_the_recorded_csharp_answers() {
    let data = include_str!("../testdata/parity.jsonl");
    let mut count = 0;
    for (n, line) in data.lines().filter(|l| !l.trim().is_empty()).enumerate() {
        let case: Value = serde_json::from_str(line).expect("parity line is JSON");
        let answer: Value =
            serde_json::from_str(&layout_json(&case["input"].to_string())).expect("JSON out");
        let want = case["expected"].as_str().expect("expected text");
        assert_eq!(canon(&answer), want, "parity case {n}");
        count += 1;
    }
    assert!(count >= 40, "only {count} parity cases");
}

/// Sonar S2259 on the C# version: `helperJson` can be null. Here a missing,
/// null or non-object `helper` must never panic: the answer is the C# one for
/// a helper with no image size (a note, no slots, the scale nearest 1.0).
#[test]
fn null_or_odd_helper_is_handled_without_a_crash() {
    let consts = r#""rewardWidth":968,"rewardHeight":235,"rewardY":316,"lineHeight":48"#;
    for helper in [
        String::new(),
        r#""helper":null,"#.to_string(),
        r#""helper":[],"#.to_string(),
        r#""helper":"text","#.to_string(),
        r#""helper":7,"#.to_string(),
        r#""helper":{"lines":null},"#.to_string(),
    ] {
        let text = format!("{{{helper}{consts}}}");
        let out: Value = serde_json::from_str(&layout_json(&text)).expect("JSON out");
        assert!(out.get("error").is_none(), "{text}");
        assert_eq!(out["slots"].as_array().map(Vec::len), Some(0), "{text}");
        assert_eq!(notes(&out), ["no image size in the helper JSON"], "{text}");
        assert_eq!(out["uiScale"].as_f64(), Some(1.0), "{text}");
    }
}

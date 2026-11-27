//! Turns the Vision lines of `wfinfo-mac rewards` into one name per reward
//! slot, with WFInfo's reward-screen geometry (1080p units, see the OCR
//! constants). For UI scale u and screen scaling s (su = s*u):
//!
//! - name rows: top = H/2 - (rewardY - rewardHeight + lineHeight)*su,
//!   bottom = H/2 - (rewardY - rewardHeight)*su;
//! - kept lines: vertical centre inside [top - L/4, bottom + L/4]
//!   (L = lineHeight*su), horizontal centre inside the strip (rewardWidth*su
//!   wide, centred on W/2), and at least one letter;
//! - slot i of n: centre W/2 + (i - (n-1)/2) * (rewardWidth/4)*su.
//!
//! Columns: lines sorted by horizontal centre; a new column starts when a line
//! is more than half a slot from the current column's mean centre. Over four
//! columns, the four that best fit the four-slot grid stay (the rest go in the
//! notes). In a column, lines are grouped into visual rows (centres within half
//! the median line height, ordered left to right), and rows join while the
//! vertical gap is under 0.6 of the median line height of all kept lines. The
//! name is the first such group with a row centre inside [top, bottom]: groups
//! above it are header text ("1 OWNED"), groups below it are squad names. If no
//! group lies in the rows, the top-most group is the name. Text is never
//! invented; a slot's candidates are the joined name rows, then shorter row
//! prefixes (for a wrapped name: all rows, then the first row).
//!
//! Unknown UI scale (uiScaleMin != uiScaleMax): every u from uiScaleMin to
//! uiScaleMax in 0.05 steps is tried with the full analysis above, and scored
//! `score(u) = rowLines + sum(align) + sum(vfit) + heightFit`, where
//! rowLines = name lines whose centre lies inside [top, bottom] (no tolerance);
//! align (per slot, 0..1) = 1 - |CenterX - gridX(u)| / (slot width/2), with the
//! grid for as many slots as were found; vfit (per slot, 0..1) = 1 - |first
//! name row centre - expected| / (L/2), expected = top + (4 + 17/2)/48 * L
//! (WFInfo names sit at the top of the rows, glyphs about 17/48 of L tall);
//! heightFit (0..1) = mean over name lines of 1 - |h - 17/48*L| / (17/96*L).
//! The highest score wins; scores within 1e-9 count as a tie, and a tie goes to
//! the u nearest 1.0. No lines at all gives the u nearest 1.0. Limit: the
//! alignment term assumes every card produced a name; a card that Vision missed
//! skews the estimate (a known scale has no such limit).
//!
//! Every arithmetic step keeps the order of the C# version this replaces
//! (`RewardLayout.cs`), so the doubles come out bit for bit the same.

use crate::dotnet::{clean, format_custom, has_letter, round4, sort_like_dotnet};
use serde_json::Value;
use std::cmp::Ordering;

const SCALE_STEP: f64 = 0.05;
const DEFAULT_SCALE_MIN: f64 = 0.5;
const DEFAULT_SCALE_MAX: f64 = 1.25;
const MAX_SLOTS: usize = 4;

/// A text box in full-image pixels, top-left origin.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LayoutBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl LayoutBox {
    fn right(&self) -> f64 {
        self.x + self.width
    }
    fn bottom(&self) -> f64 {
        self.y + self.height
    }
    pub fn center_x(&self) -> f64 {
        self.x + self.width / 2.0
    }
    fn center_y(&self) -> f64 {
        self.y + self.height / 2.0
    }

    fn union(boxes: impl Iterator<Item = LayoutBox>) -> LayoutBox {
        let (mut l, mut t, mut r, mut b) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for x in boxes {
            l = l.min(x.x);
            t = t.min(x.y);
            r = r.max(x.right());
            b = b.max(x.bottom());
        }
        if l > r {
            LayoutBox::default()
        } else {
            LayoutBox {
                x: l,
                y: t,
                width: r - l,
                height: b - t,
            }
        }
    }
}

/// One Vision text line.
#[derive(Clone, Debug, PartialEq)]
pub struct LayoutLine {
    pub text: String,
    pub confidence: f64,
    pub bx: LayoutBox,
}

/// One reward card: the name lines it used and the texts to try.
#[derive(Debug)]
pub struct RewardSlot<'a> {
    /// Measured horizontal centre of the name lines (pixels).
    pub center_x: f64,
    /// Slot centre the geometry predicts for this card (pixels).
    pub grid_x: f64,
    /// Name lines, top to bottom (left to right on one visual row).
    pub lines: Vec<&'a LayoutLine>,
    /// Part-name texts to try, best first. May be empty.
    pub candidates: Vec<String>,
    /// Lines of this column that are not the name ("1 OWNED", squad names).
    pub other_lines: Vec<&'a LayoutLine>,
}

/// The score of one tried UI scale (unknown-scale estimation only).
#[derive(Clone, Copy, Debug)]
pub struct ScaleScore {
    pub ui_scale: f64,
    pub score: f64,
}

#[derive(Debug)]
pub struct RewardLayoutResult<'a> {
    pub ui_scale: f64,
    pub ui_scale_estimated: bool,
    pub screen_scaling: f64,
    pub row_top: f64,
    pub row_bottom: f64,
    pub slots: Vec<RewardSlot<'a>>,
    pub notes: Vec<String>,
    pub scale_scores: Vec<ScaleScore>,
}

struct Geometry {
    strip_width: f64,
    row_top_offset: f64,
    row_bottom_offset: f64,
    line_height: f64,
    slot_width: f64,
    glyph_height: f64,
    name_top_offset: f64,
}

impl Geometry {
    fn new(width: i32, height: i32, y: i32, line: i32) -> Self {
        let line_f = f64::from(line);
        Geometry {
            strip_width: f64::from(width),
            row_top_offset: f64::from(y.wrapping_sub(height).wrapping_add(line)),
            row_bottom_offset: f64::from(y.wrapping_sub(height)),
            line_height: line_f,
            slot_width: f64::from(width) / MAX_SLOTS as f64,
            glyph_height: line_f * 17.0 / 48.0,
            name_top_offset: line_f * 4.0 / 48.0,
        }
    }
}

struct Evaluation<'a> {
    top: f64,
    bottom: f64,
    score: f64,
    slots: Vec<RewardSlot<'a>>,
}

struct Row<'a> {
    lines: Vec<&'a LayoutLine>,
    bx: LayoutBox,
    text: String,
}

/// Analyzes the helper JSON. Pass the OCR constants
/// (`OCR.pixleRewardWidth`, `pixleRewardHeight`, `pixleRewardYDisplay`) and the
/// line height (`OCR.pixelRewardLineHeight`, 58 for CJK). `lines` is the parsed
/// line list ([`parse_lines`]); it owns the text the result borrows.
pub fn analyze<'a>(
    helper: &Value,
    lines_in: &'a [LayoutLine],
    reward_width: i32,
    reward_height: i32,
    reward_y: i32,
    line_height: i32,
) -> RewardLayoutResult<'a> {
    let mut notes: Vec<String> = Vec::new();
    let geo = Geometry::new(reward_width, reward_height, reward_y, line_height);

    let w = num(helper.get("width")).unwrap_or(0.0);
    let h = num(helper.get("height")).unwrap_or(0.0);
    if let Some(error) = helper.get("error").and_then(Value::as_str)
        && !error.chars().all(char::is_whitespace)
    {
        notes.push(format!("helper error: {error}"));
    }

    let mut a = num(helper.get("uiScaleMin")).unwrap_or(DEFAULT_SCALE_MIN);
    let mut b = num(helper.get("uiScaleMax")).unwrap_or(DEFAULT_SCALE_MAX);
    if a.partial_cmp(&0.0) != Some(Ordering::Greater) {
        a = DEFAULT_SCALE_MIN;
    }
    if b.partial_cmp(&0.0) != Some(Ordering::Greater) {
        b = DEFAULT_SCALE_MAX;
    }
    if a > b {
        std::mem::swap(&mut a, &mut b);
    }
    let known = (a - b).abs() < 1e-9;

    if w.partial_cmp(&0.0) != Some(Ordering::Greater)
        || h.partial_cmp(&0.0) != Some(Ordering::Greater)
    {
        notes.push("no image size in the helper JSON".to_string());
        let u0 = if known { a } else { nearest_to_one(a, b) };
        return RewardLayoutResult {
            ui_scale: u0,
            ui_scale_estimated: !known,
            screen_scaling: 0.0,
            row_top: 0.0,
            row_bottom: 0.0,
            slots: Vec::new(),
            notes,
            scale_scores: Vec::new(),
        };
    }

    let mut s = num(helper.get("screenScaling")).unwrap_or(0.0);
    if s.partial_cmp(&0.0) != Some(Ordering::Greater) {
        s = (w / 1920.0).min(h / 1080.0);
    }

    let lines: Vec<&LayoutLine> = lines_in.iter().filter(|l| has_letter(&l.text)).collect();
    let no_letters = lines_in.len() - lines.len();
    if no_letters > 0 {
        notes.push(format!("{no_letters} line(s) without letters dropped"));
    }

    let u;
    let mut scores: Vec<ScaleScore> = Vec::new();
    if known {
        u = a;
    } else {
        let steps = ((b - a) / SCALE_STEP + 1e-6).floor() as i64;
        let mut tried: Vec<f64> = (0..=steps)
            .map(|k| round4(a + k as f64 * SCALE_STEP))
            .collect();
        if tried.last().is_none_or(|last| b - last > 1e-6) {
            tried.push(b);
        }
        for &t in &tried {
            scores.push(ScaleScore {
                ui_scale: t,
                score: evaluate(&lines, w, h, s, t, &geo, None).score,
            });
        }
        let best = scores.iter().map(|x| x.score).fold(f64::MIN, f64::max);
        // OrderBy(|u - 1|).ThenBy(u).First(): the first minimum wins.
        let mut pick: Option<ScaleScore> = None;
        for &x in scores.iter().filter(|x| x.score >= best - 1e-9) {
            let better = pick.is_none_or(|p| {
                let (dx, dp) = ((x.ui_scale - 1.0).abs(), (p.ui_scale - 1.0).abs());
                dx < dp || (dx == dp && x.ui_scale < p.ui_scale)
            });
            if better {
                pick = Some(x);
            }
        }
        u = pick.map_or(1.0, |p| p.ui_scale);
        notes.push(format!(
            "ui scale estimated {} (range {}-{}, score {})",
            format_custom(u, 2, 2),
            format_custom(a, 2, 2),
            format_custom(b, 2, 2),
            format_custom(best, 0, 3)
        ));
    }

    let fin = evaluate(&lines, w, h, s, u, &geo, Some(&mut notes));
    RewardLayoutResult {
        ui_scale: u,
        ui_scale_estimated: !known,
        screen_scaling: s,
        row_top: fin.top,
        row_bottom: fin.bottom,
        slots: fin.slots,
        notes,
        scale_scores: scores,
    }
}

/// Runs the full analysis for one UI scale. `notes` is `None` for scoring only.
fn evaluate<'a>(
    lines: &[&'a LayoutLine],
    w: f64,
    h: f64,
    s: f64,
    u: f64,
    geo: &Geometry,
    mut notes: Option<&mut Vec<String>>,
) -> Evaluation<'a> {
    let su = s * u;
    let lh = geo.line_height * su;
    let mut ev = Evaluation {
        top: h / 2.0 - geo.row_top_offset * su,
        bottom: h / 2.0 - geo.row_bottom_offset * su,
        score: 0.0,
        slots: Vec::new(),
    };
    let tol = 0.25 * lh;
    let slot_w = geo.slot_width * su;
    let cx0 = w / 2.0;
    let strip_half = geo.strip_width * su / 2.0;

    let in_band: Vec<&LayoutLine> = lines
        .iter()
        .copied()
        .filter(|l| l.bx.center_y() >= ev.top - tol && l.bx.center_y() <= ev.bottom + tol)
        .collect();
    let mut kept: Vec<&LayoutLine> = in_band
        .iter()
        .copied()
        .filter(|l| (l.bx.center_x() - cx0).abs() <= strip_half)
        .collect();
    if let Some(notes) = notes.as_deref_mut()
        && kept.len() < in_band.len()
    {
        // LINQ Except: distinct by value, in order.
        let mut outside: Vec<&LayoutLine> = Vec::new();
        for l in &in_band {
            if !kept.contains(l) && !outside.contains(l) {
                outside.push(l);
            }
        }
        let quoted: Vec<String> = outside.iter().map(|l| quote(&l.text)).collect();
        notes.push(format!(
            "outside the reward strip, ignored: {}",
            quoted.join(", ")
        ));
    }
    if kept.is_empty() {
        return ev;
    }

    let median_h = median(kept.iter().map(|l| l.bx.height));

    // Columns by horizontal centre.
    kept.sort_by(|a, b| cmp_f64(a.bx.center_x(), b.bx.center_x()));
    let mut columns: Vec<Vec<&LayoutLine>> = Vec::new();
    let mut col_centre = f64::NAN;
    for line in kept.iter().copied() {
        match columns.last_mut() {
            Some(last) if line.bx.center_x() - col_centre <= slot_w / 2.0 => last.push(line),
            _ => columns.push(vec![line]),
        }
        col_centre = mean_centre(columns.last().map_or(&[][..], Vec::as_slice));
    }

    if columns.len() > MAX_SLOTS {
        let centres: Vec<f64> = columns.iter().map(|c| mean_centre(c)).collect();
        let keep = best_subset(&centres, &grid(cx0, MAX_SLOTS, slot_w));
        if let Some(notes) = notes {
            let extra: Vec<String> = (0..columns.len())
                .filter(|i| !keep.contains(i))
                .map(|i| {
                    columns[i]
                        .iter()
                        .map(|l| quote(&l.text))
                        .collect::<Vec<_>>()
                        .join(" / ")
                })
                .collect();
            notes.push(format!(
                "{} columns, kept the {} that fit the slot grid; extra: {}",
                columns.len(),
                MAX_SLOTS,
                extra.join("; ")
            ));
        }
        columns = keep.iter().map(|&i| columns[i].clone()).collect();
    }

    let expected_first_y = ev.top + (geo.name_top_offset + geo.glyph_height / 2.0) * su;
    let glyph = geo.glyph_height * su;
    let mut named: Vec<(Vec<Row<'a>>, Vec<&'a LayoutLine>)> = Vec::new();
    for col in &columns {
        let groups = group_rows(split_rows(col, median_h), median_h);
        let pick = groups
            .iter()
            .position(|g| {
                g.iter()
                    .any(|r| r.bx.center_y() >= ev.top && r.bx.center_y() <= ev.bottom)
            })
            .unwrap_or(0);
        let mut name = Vec::new();
        let mut other = Vec::new();
        for (i, g) in groups.into_iter().enumerate() {
            if i == pick {
                name = g;
            } else {
                other.extend(g.into_iter().flat_map(|r| r.lines));
            }
        }
        named.push((name, other));
    }

    let n = named.len();
    let grid = grid(cx0, n, slot_w);
    let (mut row_lines, mut align_sum, mut vfit_sum, mut height_sum) = (0.0, 0.0, 0.0, 0.0);
    let mut height_count = 0_u32;
    for (i, (rows, other)) in named.into_iter().enumerate() {
        let used: Vec<&LayoutLine> = rows.iter().flat_map(|r| r.lines.iter().copied()).collect();
        let centre_x = LayoutBox::union(used.iter().map(|l| l.bx)).center_x();

        row_lines += used
            .iter()
            .filter(|l| l.bx.center_y() >= ev.top && l.bx.center_y() <= ev.bottom)
            .count() as f64;
        align_sum += 1.0 - 1.0_f64.min((centre_x - grid[i]).abs() / (slot_w / 2.0));
        vfit_sum +=
            1.0 - 1.0_f64.min((rows[0].bx.center_y() - expected_first_y).abs() / (lh / 2.0));
        for l in &used {
            height_sum += 1.0 - 1.0_f64.min((l.bx.height - glyph).abs() / (glyph / 2.0));
            height_count += 1;
        }

        ev.slots.push(RewardSlot {
            center_x: centre_x,
            grid_x: grid[i],
            lines: used,
            candidates: candidates(&rows),
            other_lines: other,
        });
    }
    ev.score = row_lines
        + align_sum
        + vfit_sum
        + if height_count > 0 {
            height_sum / f64::from(height_count)
        } else {
            0.0
        };
    ev
}

/// Visual rows: lines whose centres are within half a line height, left to right.
fn split_rows<'a>(column: &[&'a LayoutLine], median_h: f64) -> Vec<Row<'a>> {
    let mut sorted: Vec<&LayoutLine> = column.to_vec();
    sorted.sort_by(|a, b| cmp_f64(a.bx.center_y(), b.bx.center_y()).then(cmp_f64(a.bx.x, b.bx.x)));
    let mut rows: Vec<Vec<&LayoutLine>> = Vec::new();
    let mut row_y = 0.0;
    for line in sorted {
        match rows.last_mut() {
            Some(current) if line.bx.center_y() - row_y <= median_h / 2.0 => current.push(line),
            _ => {
                rows.push(vec![line]);
                row_y = line.bx.center_y();
            }
        }
    }
    rows.into_iter()
        .map(|mut lines| {
            sort_like_dotnet(&mut lines, |x, y| cmp_f64(x.bx.x, y.bx.x));
            let bx = LayoutBox::union(lines.iter().map(|l| l.bx));
            let joined: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
            let text = clean(&joined.join(" "));
            Row { lines, bx, text }
        })
        .collect()
}

/// Joins rows while the vertical gap is under 0.6 of the median line height.
fn group_rows(rows: Vec<Row<'_>>, median_h: f64) -> Vec<Vec<Row<'_>>> {
    let mut groups: Vec<Vec<Row>> = Vec::new();
    for row in rows {
        let new_group = groups
            .last()
            .and_then(|g| g.last())
            .is_none_or(|last| row.bx.y - last.bx.bottom() >= 0.6 * median_h);
        if new_group {
            groups.push(Vec::new());
        }
        if let Some(group) = groups.last_mut() {
            group.push(row);
        }
    }
    groups
}

fn candidates(rows: &[Row<'_>]) -> Vec<String> {
    let mut list: Vec<String> = Vec::new();
    for k in (1..=rows.len()).rev() {
        let joined: Vec<&str> = rows[..k].iter().map(|r| r.text.as_str()).collect();
        let text = clean(&joined.join(" "));
        if !text.is_empty() && !list.contains(&text) {
            list.push(text);
        }
    }
    list
}

fn grid(cx0: f64, n: usize, slot_w: f64) -> Vec<f64> {
    (0..n)
        .map(|i| cx0 + (i as f64 - (n as f64 - 1.0) / 2.0) * slot_w)
        .collect()
}

/// Indices (ascending) of `grid.len()` centres that best fit the grid in order.
/// The first of equal costs wins.
fn best_subset(centres: &[f64], grid: &[f64]) -> Vec<usize> {
    struct Search<'s> {
        centres: &'s [f64],
        grid: &'s [f64],
        pick: Vec<usize>,
        best: Vec<usize>,
        best_cost: f64,
    }
    fn recurse(s: &mut Search, depth: usize, start: usize, cost: f64) {
        if cost >= s.best_cost {
            return;
        }
        if depth == s.grid.len() {
            s.best_cost = cost;
            s.best = s.pick.clone();
            return;
        }
        let last = s.centres.len() - (s.grid.len() - depth);
        for i in start..=last {
            s.pick[depth] = i;
            let next = cost + (s.centres[i] - s.grid[depth]).abs();
            recurse(s, depth + 1, i + 1, next);
        }
    }
    let mut search = Search {
        centres,
        grid,
        pick: vec![0; grid.len()],
        best: Vec::new(),
        best_cost: f64::MAX,
    };
    recurse(&mut search, 0, 0, 0.0);
    search.best
}

/// Reads the helper's `lines`: text (cleaned), confidence and box. A line with
/// no text, a missing box value or a non-positive height is skipped.
pub fn parse_lines(token: Option<&Value>) -> Vec<LayoutLine> {
    let Some(array) = token.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for item in array {
        let Some(o) = item.as_object() else { continue };
        let text = o
            .get("text")
            .and_then(Value::as_str)
            .map_or_else(String::new, clean);
        let bx = o.get("box");
        let field = |name: &str| num(bx.and_then(|b| b.get(name)));
        let (Some(x), Some(y), Some(width), Some(height)) =
            (field("x"), field("y"), field("width"), field("height"))
        else {
            continue;
        };
        if text.is_empty() || height <= 0.0 {
            continue;
        }
        result.push(LayoutLine {
            text,
            confidence: num(o.get("confidence")).unwrap_or(0.0),
            bx: LayoutBox {
                x,
                y,
                width,
                height,
            },
        });
    }
    result
}

/// A finite JSON number as a double, else `None` (strings are not numbers).
fn num(token: Option<&Value>) -> Option<f64> {
    token.and_then(Value::as_f64).filter(|v| v.is_finite())
}

fn cmp_f64(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

/// Mean of the line centres: first element plus the rest in order, then divided
/// (LINQ `Average`).
fn mean_centre(lines: &[&LayoutLine]) -> f64 {
    let mut it = lines.iter();
    let Some(first) = it.next() else {
        return f64::NAN;
    };
    let mut sum = first.bx.center_x();
    for l in it {
        sum += l.bx.center_x();
    }
    sum / lines.len() as f64
}

fn median(values: impl Iterator<Item = f64>) -> f64 {
    let mut v: Vec<f64> = values.collect();
    v.sort_by(|a, b| cmp_f64(*a, *b));
    if v.is_empty() {
        return 0.0;
    }
    if v.len() % 2 == 1 {
        v[v.len() / 2]
    } else {
        (v[v.len() / 2 - 1] + v[v.len() / 2]) / 2.0
    }
}

fn nearest_to_one(a: f64, b: f64) -> f64 {
    b.min(a.max(1.0))
}

fn quote(s: &str) -> String {
    format!("\"{s}\"")
}

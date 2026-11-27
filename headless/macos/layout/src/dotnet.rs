//! The .NET behaviours the layout depends on, spelled out so the Rust port
//! gives the same results: `char.IsLetter`, `string.Split(null)`,
//! `Math.Round(x, 4)`, custom number formats (`0.00`, `0.###`) and
//! `List<T>.Sort` (introsort, not stable).

use crate::letters::LETTER_RANGES;
use std::cmp::Ordering;

/// `text.Any(char.IsLetter)`: .NET tests UTF-16 units, so a character above
/// U+FFFF (two surrogate units) is never a letter.
pub(crate) fn has_letter(text: &str) -> bool {
    text.chars().any(is_letter)
}

fn is_letter(c: char) -> bool {
    let Ok(unit) = u16::try_from(u32::from(c)) else {
        return false;
    };
    LETTER_RANGES
        .binary_search_by(|&(lo, hi)| {
            if unit < lo {
                Ordering::Greater
            } else if unit > hi {
                Ordering::Less
            } else {
                Ordering::Equal
            }
        })
        .is_ok()
}

/// `string.Join(" ", s.Split((char[])null, RemoveEmptyEntries))`: runs of
/// white space (`char.IsWhiteSpace`, the same set as Rust's) become one space.
pub(crate) fn clean(s: &str) -> String {
    s.split(char::is_whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// `Math.Round(value, 4)`. Recent .NET rounds the exact value of the double
/// (half to even on an exact tie), not `value * 10000` (0.40005 is a hair
/// above the middle and gives 0.4001, although 0.40005 * 10000 is 4000.5).
/// Rust's `{:.4}` rounds the exact value too, and parsing the text gives the
/// nearest double, as the division by 10000 does. Values of 1e16 and more are
/// returned unchanged.
pub(crate) fn round4(value: f64) -> f64 {
    if value.abs() < 1e16 {
        format!("{value:.4}").parse().unwrap_or(value)
    } else {
        value
    }
}

/// `double.ToString("0.00")` and `"0.###"` for finite values: .NET custom
/// formats work on the first 15 significant digits and round those half up
/// (so 0.625 gives "0.63", unlike Rust's `{:.2}`).
pub(crate) fn format_custom(value: f64, min_decimals: usize, max_decimals: usize) -> String {
    if value < 0.0 {
        return format!("-{}", format_custom(-value, min_decimals, max_decimals));
    }
    let (mut digits, mut scale) = if value == 0.0 {
        (Vec::new(), 0_i32)
    } else {
        let text = format!("{value:.14e}");
        let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
        let digits: Vec<u8> = mantissa.bytes().filter(u8::is_ascii_digit).collect();
        (digits, exponent.parse::<i32>().unwrap_or(0) + 1)
    };
    // `scale` digits sit before the decimal point.
    let keep = i64::from(scale) + max_decimals as i64;
    if keep < 0 {
        digits.clear();
        scale = 0;
    } else if (keep as usize) < digits.len() {
        let keep = keep as usize;
        let round_up = digits[keep] >= b'5';
        digits.truncate(keep);
        if round_up {
            let mut i = digits.len();
            loop {
                if i == 0 {
                    digits.insert(0, b'1');
                    scale += 1;
                    break;
                }
                i -= 1;
                if digits[i] == b'9' {
                    digits[i] = b'0';
                } else {
                    digits[i] += 1;
                    break;
                }
            }
        }
    }
    let digit_at = |index: i64| -> char {
        usize::try_from(index)
            .ok()
            .and_then(|i| digits.get(i))
            .map_or('0', |&d| char::from(d))
    };
    let mut out = String::new();
    if scale <= 0 {
        out.push('0');
    } else {
        for i in 0..i64::from(scale) {
            out.push(digit_at(i));
        }
    }
    let mut fraction: String = (0..max_decimals as i64)
        .map(|p| digit_at(i64::from(scale) + p))
        .collect();
    while fraction.len() > min_decimals && fraction.ends_with('0') {
        fraction.pop();
    }
    if !fraction.is_empty() {
        out.push('.');
        out.push_str(&fraction);
    }
    out
}

/// `List<T>.Sort(Comparison<T>)`: .NET's introsort. It is not stable (three
/// equal keys can swap), so ties must go through the same steps to give the
/// same order.
pub(crate) fn sort_like_dotnet<T: Clone>(keys: &mut [T], mut cmp: impl FnMut(&T, &T) -> Ordering) {
    if keys.len() > 1 {
        let depth = 2 * (keys.len().ilog2() as usize + 1);
        intro_sort(keys, depth, &mut cmp);
    }
}

const INTROSORT_SIZE_THRESHOLD: usize = 16;

fn swap_if_greater<T>(
    keys: &mut [T],
    cmp: &mut impl FnMut(&T, &T) -> Ordering,
    i: usize,
    j: usize,
) {
    if cmp(&keys[i], &keys[j]) == Ordering::Greater {
        keys.swap(i, j);
    }
}

fn intro_sort<T: Clone>(
    mut keys: &mut [T],
    mut depth_limit: usize,
    cmp: &mut impl FnMut(&T, &T) -> Ordering,
) {
    while keys.len() > 1 {
        let size = keys.len();
        if size <= INTROSORT_SIZE_THRESHOLD {
            match size {
                2 => swap_if_greater(keys, cmp, 0, 1),
                3 => {
                    swap_if_greater(keys, cmp, 0, 1);
                    swap_if_greater(keys, cmp, 0, 2);
                    swap_if_greater(keys, cmp, 1, 2);
                }
                _ => insertion_sort(keys, cmp),
            }
            return;
        }
        if depth_limit == 0 {
            heap_sort(keys, cmp);
            return;
        }
        depth_limit -= 1;
        let p = pick_pivot_and_partition(keys, cmp);
        let (left, right) = keys.split_at_mut(p + 1);
        intro_sort(right, depth_limit, cmp);
        keys = &mut left[..p];
    }
}

fn pick_pivot_and_partition<T: Clone>(
    keys: &mut [T],
    cmp: &mut impl FnMut(&T, &T) -> Ordering,
) -> usize {
    let hi = keys.len() - 1;
    let middle = hi >> 1;
    swap_if_greater(keys, cmp, 0, middle);
    swap_if_greater(keys, cmp, 0, hi);
    swap_if_greater(keys, cmp, middle, hi);
    let pivot = keys[middle].clone();
    keys.swap(middle, hi - 1);
    let mut left = 0;
    let mut right = hi - 1;
    while left < right {
        left += 1;
        while cmp(&keys[left], &pivot) == Ordering::Less {
            left += 1;
        }
        right -= 1;
        while cmp(&pivot, &keys[right]) == Ordering::Less {
            right -= 1;
        }
        if left >= right {
            break;
        }
        keys.swap(left, right);
    }
    if left != hi - 1 {
        keys.swap(left, hi - 1);
    }
    left
}

fn insertion_sort<T: Clone>(keys: &mut [T], cmp: &mut impl FnMut(&T, &T) -> Ordering) {
    for i in 0..keys.len() - 1 {
        let t = keys[i + 1].clone();
        let mut j = i as isize;
        while j >= 0 && cmp(&t, &keys[j as usize]) == Ordering::Less {
            keys[(j + 1) as usize] = keys[j as usize].clone();
            j -= 1;
        }
        keys[(j + 1) as usize] = t;
    }
}

fn heap_sort<T: Clone>(keys: &mut [T], cmp: &mut impl FnMut(&T, &T) -> Ordering) {
    let n = keys.len();
    for i in (1..=n / 2).rev() {
        down_heap(keys, i, n, cmp);
    }
    for i in (2..=n).rev() {
        keys.swap(0, i - 1);
        down_heap(keys, 1, i - 1, cmp);
    }
}

fn down_heap<T: Clone>(
    keys: &mut [T],
    mut i: usize,
    n: usize,
    cmp: &mut impl FnMut(&T, &T) -> Ordering,
) {
    let d = keys[i - 1].clone();
    while i <= n / 2 {
        let mut child = 2 * i;
        if child < n && cmp(&keys[child - 1], &keys[child]) == Ordering::Less {
            child += 1;
        }
        if cmp(&d, &keys[child - 1]) != Ordering::Less {
            break;
        }
        keys[i - 1] = keys[child - 1].clone();
        i = child;
    }
    keys[i - 1] = d;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_follow_dotnet() {
        assert!(has_letter("a"));
        assert!(has_letter("Ä"));
        assert!(has_letter("名前"));
        assert!(!has_letter("== 42 =="));
        assert!(!has_letter("Ⅻ")); // roman numeral: Nl, not a letter
        assert!(!has_letter("\u{301}")); // combining mark
        assert!(!has_letter("\u{1D400}")); // astral letter: two surrogates in .NET
    }

    #[test]
    fn clean_collapses_white_space() {
        assert_eq!(clean("  a \u{a0}\u{3000}b\t\nc  "), "a b c");
        assert_eq!(clean("   "), "");
        assert_eq!(clean("a\u{200b}b"), "a\u{200b}b");
    }

    #[test]
    fn round4_rounds_the_exact_value() {
        // exact ties (multiples of 1/32) go to even; near ties follow the exact value
        assert_eq!(round4(0.03125), 0.0312);
        assert_eq!(round4(0.09375), 0.0938);
        assert_eq!(round4(0.25005 + 3.0 * 0.05), 0.4001);
        assert_eq!(round4(0.25005 + 2.0 * 0.05), 0.35);
        assert_eq!(round4(1e16), 1e16);
    }

    #[test]
    fn custom_format_rounds_half_up_on_15_digits() {
        assert_eq!(format_custom(0.625, 2, 2), "0.63");
        assert_eq!(format_custom(1.005, 2, 2), "1.01");
        assert_eq!(format_custom(0.8, 2, 2), "0.80");
        assert_eq!(format_custom(9.999, 2, 2), "10.00");
        assert_eq!(format_custom(0.0, 2, 2), "0.00");
        assert_eq!(format_custom(0.0, 0, 3), "0");
        assert_eq!(format_custom(3.2166666, 0, 3), "3.217");
        assert_eq!(format_custom(2.5, 0, 3), "2.5");
        assert_eq!(format_custom(0.0004, 0, 3), "0");
        assert_eq!(format_custom(0.0005, 0, 3), "0.001");
        assert_eq!(format_custom(12345.6789, 2, 2), "12345.68");
    }

    #[test]
    fn sort_is_not_stable_for_three_equal_keys() {
        // .NET swaps equal keys in its three-element network: (1,a) (1,b) (0,c)
        // ends as c, b, a.
        let mut v = vec![(1, 'a'), (1, 'b'), (0, 'c')];
        sort_like_dotnet(&mut v, |x, y| x.0.cmp(&y.0));
        assert_eq!(v, vec![(0, 'c'), (1, 'b'), (1, 'a')]);
    }

    #[test]
    fn sort_orders_large_inputs() {
        let mut v: Vec<i32> = (0..500).map(|i| (i * 7919) % 211).collect();
        let mut expect = v.clone();
        expect.sort_unstable();
        sort_like_dotnet(&mut v, |a, b| a.cmp(b));
        assert_eq!(v, expect);
        let mut v = vec![5; 100];
        sort_like_dotnet(&mut v, |a, b| a.cmp(b));
        assert_eq!(v, vec![5; 100]);
    }
}

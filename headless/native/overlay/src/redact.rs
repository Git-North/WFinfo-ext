//! No answer may carry the user's home folder (errors/AGENTS.md: write `~`).
//! The default socket path is under it, and plugin errors can name files.

use serde_json::Value;

/// The home folders in the environment, as text can spell them.
pub fn homes() -> Vec<String> {
    let mut homes = Vec::new();
    for name in ["HOME", "USERPROFILE"] {
        let Ok(home) = std::env::var(name) else {
            continue;
        };
        let home = home.trim_end_matches(['/', '\\']);
        // "" and a bare root would turn every path into "~".
        if home.len() > 1 && !home.ends_with(':') {
            if home.contains('\\') {
                // As inside JSON text.
                homes.push(home.replace('\\', "\\\\"));
            }
            homes.push(home.to_owned());
        }
    }
    homes
}

/// `text` with each home folder written as `~`. A longer name that only
/// starts like a home folder (`/home/user2` for `/home/user`) stays.
pub fn text(text: &str, homes: &[String]) -> String {
    homes.iter().fold(text.to_owned(), |text, home| {
        let mut pieces = text.split(home.as_str());
        let mut out = pieces.next().unwrap_or_default().to_owned();
        for piece in pieces {
            let longer_name =
                piece.starts_with(|c: char| c.is_alphanumeric() || c == '_' || c == '-');
            out.push_str(if longer_name { home } else { "~" });
            out.push_str(piece);
        }
        out
    })
}

/// Every string in `value`, redacted.
pub fn value(value: &mut Value, homes: &[String]) {
    match value {
        Value::String(string) => *string = text(string, homes),
        Value::Array(items) => items.iter_mut().for_each(|item| self::value(item, homes)),
        Value::Object(fields) => fields
            .values_mut()
            .for_each(|field| self::value(field, homes)),
        _ => {}
    }
}

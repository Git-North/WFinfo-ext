//! The codes of errors/catalog.json: the overlay client owns the `PLG` area.
//! `tests/catalog.rs` checks this file against the catalog.

use crate::error::Kind;

/// The words for generated names (`generated.words` in the catalog).
pub const WORDS: [&str; 64] = [
    "Otter", "Heron", "Lynx", "Badger", "Falcon", "Marten", "Puffin", "Walrus", "Ibis", "Gecko",
    "Tapir", "Narwhal", "Pika", "Quokka", "Wombat", "Yak", "Bison", "Crane", "Dingo", "Egret",
    "Ferret", "Gannet", "Hare", "Jackal", "Kestrel", "Lemur", "Moose", "Newt", "Ocelot", "Plover",
    "Raven", "Stoat", "Toucan", "Urchin", "Vole", "Wren", "Zebu", "Alpaca", "Beaver", "Cobra",
    "Dormouse", "Eland", "Finch", "Gibbon", "Hornet", "Iguana", "Jay", "Koala", "Lark", "Mantis",
    "Nightjar", "Oriole", "Pelican", "Quail", "Robin", "Shrike", "Tern", "Viper", "Weasel",
    "Avocet", "Bittern", "Curlew", "Dunlin", "Eider",
];

/// The input of the generated code for a panic in this library:
/// `<error type>|<function path>`.
pub const PANIC_INPUT: &str = "panic|wfinfo_overlay::handle";

/// A code and its name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Code {
    /// `PLG-nnn`, or `GEN-xxxxxx` for an error with no catalog entry.
    pub code: String,
    /// The one-word name.
    pub name: &'static str,
}

/// FNV-1a, 32 bit.
#[must_use]
pub fn fnv1a32(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811c_9dc5, |hash, &byte| {
        (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193)
    })
}

/// The catalog's rule for an error with no entry.
#[must_use]
pub fn generated(input: &str) -> Code {
    let hash = fnv1a32(input.as_bytes());
    // The remainder of a division by 64 fits every integer type.
    let word = (hash % 64) as usize;
    Code {
        code: format!("GEN-{:06x}", (hash >> 8) & 0x00ff_ffff),
        name: WORDS[word],
    }
}

impl Kind {
    /// The catalog code and name of this kind of failure. A panic has no
    /// entry, so it gets a generated code.
    #[must_use]
    pub fn code(self) -> Code {
        let (code, name) = match self {
            Self::SocketMissing => ("PLG-001", "Vacancy"),
            Self::Refused => ("PLG-002", "Drawbridge"),
            Self::Timeout => ("PLG-003", "Molasses"),
            Self::PluginNotReady => ("PLG-004", "Cocoon"),
            Self::BadAnswer => ("PLG-005", "Riddle"),
            Self::UnknownWindow => ("PLG-006", "Signpost"),
            Self::SocketPermission => ("PLG-007", "Padlock"),
            Self::WindowNotOpen => ("PLG-008", "Curtain"),
            Self::PluginFailed => ("PLG-009", "Thistle"),
            Self::NoAnswer => ("PLG-010", "Hush"),
            Self::AnswerTooLarge => ("PLG-011", "Avalanche"),
            Self::NotASocket => ("PLG-012", "Decoy"),
            Self::NoSocketPath => ("PLG-013", "Waypoint"),
            Self::BadSocketPath => ("PLG-014", "Bramble"),
            Self::NoUnixSockets => ("PLG-015", "Fossil"),
            Self::ConnectFailed => ("PLG-016", "Snag"),
            Self::Io => ("PLG-017", "Splinter"),
            Self::BadRequest => ("PLG-018", "Misprint"),
            // PLG-019 and PLG-020 are about this library itself, so only
            // its caller (headless/OverlayPin.cs) can report them.
            Self::Internal => return generated(PANIC_INPUT),
        };
        Code {
            code: code.to_owned(),
            name,
        }
    }
}

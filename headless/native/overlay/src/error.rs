//! What can go wrong, each case with its own kind and a message that says what
//! happened.

use std::fmt;

/// The kind of a failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// The caller's request is not valid.
    BadRequest,
    /// The request, or the plugin, does not know the window.
    UnknownWindow,
    /// The environment does not give a socket path.
    NoSocketPath,
    /// The path cannot name a Unix socket (usually: too long).
    BadSocketPath,
    /// There is no file at the socket path.
    SocketMissing,
    /// The file at the socket path is not a socket.
    NotASocket,
    /// The user may not use the socket.
    SocketPermission,
    /// The system has no Unix-domain sockets.
    NoUnixSockets,
    /// The socket file is there but nothing listens.
    Refused,
    /// The connect failed for another reason.
    ConnectFailed,
    /// No answer before the deadline.
    Timeout,
    /// The socket failed during the exchange.
    Io,
    /// The plugin closed the connection without an answer.
    NoAnswer,
    /// The answer is too long.
    AnswerTooLarge,
    /// The answer is not the JSON object the protocol promises.
    BadAnswer,
    /// The plugin's backend answers, but its frontend does not.
    PluginNotReady,
    /// The window to change is not open in the overlay.
    WindowNotOpen,
    /// The plugin reported another failure.
    PluginFailed,
    /// A bug in this library.
    Internal,
}

impl Kind {
    /// Every kind.
    pub const ALL: [Self; 19] = [
        Self::BadRequest,
        Self::UnknownWindow,
        Self::NoSocketPath,
        Self::BadSocketPath,
        Self::SocketMissing,
        Self::NotASocket,
        Self::SocketPermission,
        Self::NoUnixSockets,
        Self::Refused,
        Self::ConnectFailed,
        Self::Timeout,
        Self::Io,
        Self::NoAnswer,
        Self::AnswerTooLarge,
        Self::BadAnswer,
        Self::PluginNotReady,
        Self::WindowNotOpen,
        Self::PluginFailed,
        Self::Internal,
    ];
}

/// A failure: its kind and a message for the user.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    /// What kind of failure.
    pub kind: Kind,
    /// What happened and, where there is something to do, what to do.
    pub message: String,
}

impl Error {
    /// A failure of `kind` with `message`.
    #[must_use]
    pub fn new(kind: Kind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

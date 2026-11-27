//! One exchange with the plugin: connect, send one line, read one line. Every
//! step shares one deadline, so a hung Steam cannot hold the caller.

use std::fs;
use std::io::{self, Read};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use socket2::{Domain, SockAddr, Socket, Type};

use crate::error::{Error, Kind};

/// Waits between connect attempts when the plugin refuses, about 0.8 s in all
/// (the demo CLI's values). The plugin answers one request at a time, and
/// macOS refuses a connect when the listen backlog is full; a restarting
/// plugin refuses between `bind` and `listen`.
const CONNECT_RETRY_MS: [u64; 5] = [25, 50, 100, 200, 400];

/// The longest answer the client reads.
pub const MAX_ANSWER_BYTES: usize = 4 * 1024 * 1024;

/// Sends `line` to the plugin's socket at `path` and returns its answer line,
/// trimmed. The whole call takes at most `timeout`, plus scheduling delay.
///
/// # Errors
/// An [`Error`] that says which step failed and what the user can do.
pub fn exchange(path: &Path, line: &str, timeout: Duration) -> Result<String, Error> {
    let deadline = Deadline {
        end: Instant::now() + timeout,
        timeout,
    };
    check_socket_file(path)?;
    let socket = connect(path, &deadline)?;
    send(&socket, format!("{line}\n").as_bytes(), &deadline)?;
    receive(&socket, &deadline)
}

struct Deadline {
    end: Instant,
    timeout: Duration,
}

impl Deadline {
    /// The time left, or the timeout error when there is none.
    fn remaining(&self) -> Result<Duration, Error> {
        let left = self.end.saturating_duration_since(Instant::now());
        if left.is_zero() {
            Err(self.expired())
        } else {
            Ok(left)
        }
    }

    fn expired(&self) -> Error {
        Error::new(
            Kind::Timeout,
            format!(
                "no answer within {} ms (the plugin's frontend may be busy or not loaded)",
                self.timeout.as_millis()
            ),
        )
    }
}

fn missing(path: &Path) -> Error {
    Error::new(
        Kind::SocketMissing,
        format!(
            "no plugin socket at {}. Is Steam running with Millennium and the Overlay Auto-Pin plugin enabled?",
            path.display()
        ),
    )
}

fn denied(path: &Path, cause: &io::Error) -> Error {
    Error::new(
        Kind::SocketPermission,
        format!(
            "no permission to use the plugin socket at {} ({cause}). The plugin lets only the user who runs Steam connect.",
            path.display()
        ),
    )
}

fn check_socket_file(path: &Path) -> Result<(), Error> {
    // On Windows an AF_UNIX socket file is a reparse point that cannot be
    // followed, so look at the entry itself there.
    let found = if cfg!(windows) {
        fs::symlink_metadata(path)
    } else {
        fs::metadata(path)
    };
    match found {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Err(missing(path)),
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => Err(denied(path, &e)),
        // Anything else: let connect give the real answer.
        Err(_) => Ok(()),
        Ok(metadata) => check_file_type(path, &metadata),
    }
}

#[cfg(unix)]
fn check_file_type(path: &Path, metadata: &fs::Metadata) -> Result<(), Error> {
    use std::os::unix::fs::FileTypeExt;

    if metadata.file_type().is_socket() {
        Ok(())
    } else {
        Err(Error::new(
            Kind::NotASocket,
            format!("{} exists but is not a socket", path.display()),
        ))
    }
}

#[cfg(not(unix))]
fn check_file_type(_path: &Path, _metadata: &fs::Metadata) -> Result<(), Error> {
    Ok(())
}

fn connect(path: &Path, deadline: &Deadline) -> Result<Socket, Error> {
    let address = SockAddr::unix(path).map_err(|e| {
        Error::new(
            Kind::BadSocketPath,
            format!("cannot use {} as a socket path: {e}", path.display()),
        )
    })?;
    let mut delays = CONNECT_RETRY_MS.into_iter().map(Duration::from_millis);
    let mut was_refused = false;
    loop {
        let socket = Socket::new(Domain::UNIX, Type::STREAM, None).map_err(|e| {
            Error::new(
                Kind::NoUnixSockets,
                format!(
                    "this system gives no Unix-domain sockets (Windows needs 10 1803 or later): {e}"
                ),
            )
        })?;
        let cause = match try_connect(&socket, &address, deadline.remaining()?) {
            Ok(()) => return Ok(socket),
            Err(cause) => cause,
        };
        let refused = cause.kind() == io::ErrorKind::ConnectionRefused;
        // Linux: a full listen backlog answers EAGAIN on a non-blocking connect.
        let busy = cause.kind() == io::ErrorKind::WouldBlock;
        // A restarting plugin removes the socket file before it makes a new one.
        let replacing = was_refused && cause.kind() == io::ErrorKind::NotFound;
        was_refused |= refused;
        // No retry once the next wait would pass the deadline: the error then
        // names the real cause instead of a timeout.
        if (refused || busy || replacing)
            && let Some(delay) = delays.next()
            && delay < deadline.remaining()?
        {
            thread::sleep(delay);
            continue;
        }
        return Err(connect_error(path, &cause, deadline));
    }
}

fn connect_error(path: &Path, cause: &io::Error, deadline: &Deadline) -> Error {
    match cause.kind() {
        io::ErrorKind::ConnectionRefused => Error::new(
            Kind::Refused,
            format!(
                "cannot connect to {} ({cause}). The socket file is there but nothing answers: Steam may have quit without removing it.",
                path.display()
            ),
        ),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => Error::new(
            Kind::Timeout,
            format!(
                "the plugin at {} did not accept the connection within {} ms (its queue is full: Steam may be hung)",
                path.display(),
                deadline.timeout.as_millis()
            ),
        ),
        io::ErrorKind::NotFound => missing(path),
        io::ErrorKind::PermissionDenied => denied(path, cause),
        _ => Error::new(
            Kind::ConnectFailed,
            format!("cannot connect to {}: {cause}", path.display()),
        ),
    }
}

/// A connect that cannot block longer than `timeout`; the socket is left in
/// blocking mode.
#[cfg(unix)]
fn try_connect(socket: &Socket, address: &SockAddr, _timeout: Duration) -> io::Result<()> {
    // A Unix-socket connect either finishes or fails at once when it is
    // non-blocking. A blocking one waits without limit on Linux when the
    // backlog is full. socket2's `connect_timeout` reads that EAGAIN as "in
    // progress", so it is not usable here.
    socket.set_nonblocking(true)?;
    socket.connect(address)?;
    socket.set_nonblocking(false)
}

#[cfg(not(unix))]
fn try_connect(socket: &Socket, address: &SockAddr, timeout: Duration) -> io::Result<()> {
    socket.connect_timeout(address, timeout)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn send_some(socket: &Socket, bytes: &[u8]) -> io::Result<usize> {
    socket.send_with_flags(bytes, libc::MSG_NOSIGNAL)
}

/// Apple platforms need no flag: socket2 sets `SO_NOSIGPIPE` on new sockets.
#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn send_some(socket: &Socket, bytes: &[u8]) -> io::Result<usize> {
    socket.send(bytes)
}

/// Bounds the next send or read by the time left.
///
/// macOS refuses socket options once the peer has closed. The socket then goes
/// non-blocking: what the peer sent is still there to read, and nothing can
/// block.
fn limit(
    socket: &Socket,
    set: fn(&Socket, Option<Duration>) -> io::Result<()>,
    deadline: &Deadline,
) -> Result<(), Error> {
    // The system reads a zero timeout as "no limit", and socket2 rounds a
    // shorter time down to zero (microseconds; milliseconds on Windows).
    let left = deadline.remaining()?.max(Duration::from_millis(1));
    if set(socket, Some(left)).is_err() {
        socket
            .set_nonblocking(true)
            .map_err(|e| io_error("set up", &e))?;
    }
    Ok(())
}

fn io_error(step: &str, cause: &io::Error) -> Error {
    Error::new(Kind::Io, format!("socket error on {step}: {cause}"))
}

/// What to do after a send or read failed: `Ok` means try again.
fn retry_after(step: &str, cause: &io::Error, deadline: &Deadline) -> Result<(), Error> {
    match cause.kind() {
        io::ErrorKind::Interrupted => Ok(()),
        // A socket timeout, or nothing to do yet on a non-blocking socket.
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => {
            let left = deadline.remaining()?;
            thread::sleep(left.min(Duration::from_millis(1)));
            Ok(())
        }
        _ => Err(io_error(step, cause)),
    }
}

fn send(socket: &Socket, mut bytes: &[u8], deadline: &Deadline) -> Result<(), Error> {
    while !bytes.is_empty() {
        limit(socket, Socket::set_write_timeout, deadline)?;
        match send_some(socket, bytes) {
            Ok(0) => return Err(Error::new(Kind::Io, "socket error on send: nothing sent")),
            Ok(sent) => bytes = &bytes[sent..],
            Err(e) => retry_after("send", &e, deadline)?,
        }
    }
    Ok(())
}

fn receive(mut socket: &Socket, deadline: &Deadline) -> Result<String, Error> {
    let mut answer = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        limit(socket, Socket::set_read_timeout, deadline)?;
        let count = match socket.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => count,
            Err(e) => {
                retry_after("read", &e, deadline)?;
                continue;
            }
        };
        let piece = &chunk[..count];
        let end = piece.iter().position(|&byte| byte == b'\n');
        answer.extend_from_slice(&piece[..end.unwrap_or(count)]);
        if answer.len() > MAX_ANSWER_BYTES {
            return Err(Error::new(
                Kind::AnswerTooLarge,
                format!("the answer is longer than {MAX_ANSWER_BYTES} bytes"),
            ));
        }
        if end.is_some() {
            break;
        }
    }
    let text = String::from_utf8(answer)
        .map_err(|_| Error::new(Kind::BadAnswer, "the plugin's answer is not UTF-8"))?;
    let text = text.trim();
    if text.is_empty() {
        return Err(Error::new(
            Kind::NoAnswer,
            "the plugin closed the connection without an answer",
        ));
    }
    Ok(text.to_owned())
}

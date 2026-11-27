//! A fake plugin: a Unix-socket server that speaks the plugin's protocol, or
//! breaks it in a chosen way. No test talks to the real plugin.

// Each test crate uses a different part of this module.
#![allow(dead_code)]

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{Value, json};
use socket2::{Domain, SockAddr, Socket, Type};
use wfinfo_overlay::{Failure, Request, call};

/// A short-lived directory for sockets, removed on drop. Unix socket paths are
/// short (104 bytes on macOS), so the names are too.
pub struct TestDir(PathBuf);

impl TestDir {
    pub fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "wfo-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).expect("create the test directory");
        Self(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn socket(&self) -> PathBuf {
        self.0.join("p.sock")
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// What the fake plugin does with each connection.
#[derive(Clone)]
pub enum Behavior {
    /// Read the request line, send these bytes, close.
    Send(Vec<u8>),
    /// Read the request line, send these bytes, keep the connection open.
    SendAndHold(Vec<u8>),
    /// Read the request line, send each piece with a pause before it, close.
    SendPieces(Vec<Vec<u8>>, Duration),
    /// Read the request line, then send one byte per pause, without end.
    Trickle(Duration),
    /// Read the request line and never answer.
    Silent,
    /// Close without reading anything.
    CloseAtOnce,
    /// Accept and then neither read nor close.
    NeverRead,
}

impl Behavior {
    /// One answer line.
    pub fn line(text: &str) -> Self {
        Self::Send(format!("{text}\n").into_bytes())
    }

    pub fn json(value: &Value) -> Self {
        Self::line(&value.to_string())
    }
}

/// A socket bound at `path` that does not listen yet: connects are refused,
/// as in the plugin between `bind` and `listen`.
pub fn bind(path: &Path) -> Socket {
    let socket = Socket::new(Domain::UNIX, Type::STREAM, None).expect("socket");
    socket
        .bind(&SockAddr::unix(path).expect("socket address"))
        .expect("bind");
    socket
}

pub struct FakePlugin {
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    server: Option<JoinHandle<()>>,
}

impl FakePlugin {
    pub fn start(path: &Path, behavior: Behavior) -> Self {
        Self::serve(bind(path), behavior)
    }

    /// Listens on a socket from [`bind`] and serves it until dropped.
    pub fn serve(listener: Socket, behavior: Behavior) -> Self {
        listener.listen(16).expect("listen");
        listener.set_nonblocking(true).expect("non-blocking");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let server = {
            let requests = Arc::clone(&requests);
            let stop = Arc::clone(&stop);
            thread::spawn(move || {
                let mut clients = Vec::new();
                while !stop.load(Ordering::Relaxed) {
                    let Ok((client, _)) = listener.accept() else {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    };
                    let behavior = behavior.clone();
                    let requests = Arc::clone(&requests);
                    let stop = Arc::clone(&stop);
                    clients.push(thread::spawn(move || {
                        serve_client(client, behavior, &requests, &stop);
                    }));
                }
                for client in clients {
                    client.join().expect("client thread");
                }
            })
        };
        Self {
            requests,
            stop,
            server: Some(server),
        }
    }

    /// The request lines received so far, newline included.
    pub fn requests(&self) -> Vec<String> {
        self.requests.lock().expect("requests").clone()
    }
}

impl Drop for FakePlugin {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(server) = self.server.take() {
            let result = server.join();
            if !thread::panicking() {
                result.expect("server thread");
            }
        }
    }
}

fn serve_client(
    mut client: Socket,
    behavior: Behavior,
    requests: &Mutex<Vec<String>>,
    stop: &AtomicBool,
) {
    // Accepted sockets inherit non-blocking mode on macOS.
    client.set_nonblocking(false).expect("blocking");
    let hold = |stop: &AtomicBool| {
        while !stop.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(2));
        }
    };
    match behavior {
        Behavior::CloseAtOnce => return,
        Behavior::NeverRead => return hold(stop),
        _ => {}
    }
    let mut line = Vec::new();
    let mut byte = [0_u8; 1];
    while !line.ends_with(b"\n") {
        match client.read(&mut byte) {
            Ok(1) => line.push(byte[0]),
            _ => break,
        }
    }
    requests
        .lock()
        .expect("requests")
        .push(String::from_utf8_lossy(&line).into_owned());
    // The client may close early (too large, timed out): send errors are fine.
    match behavior {
        Behavior::Send(bytes) => {
            let _ = client.write_all(&bytes);
        }
        Behavior::SendAndHold(bytes) => {
            let _ = client.write_all(&bytes);
            hold(stop);
        }
        Behavior::SendPieces(pieces, pause) => {
            for piece in pieces {
                thread::sleep(pause);
                let _ = client.write_all(&piece);
            }
        }
        Behavior::Trickle(pause) => {
            while !stop.load(Ordering::Relaxed) && client.write_all(b"x").is_ok() {
                thread::sleep(pause);
            }
        }
        Behavior::Silent => hold(stop),
        Behavior::CloseAtOnce | Behavior::NeverRead => {}
    }
}

/// A request for the fake plugin at `socket`: `extra` plus the socket path and
/// a timeout generous enough for a loaded CI machine.
pub fn request_json(socket: &Path, extra: &Value) -> String {
    let mut request = json!({ "socket": socket, "timeoutMs": 5000 });
    let fields = request.as_object_mut().expect("object");
    for (key, value) in extra.as_object().expect("object") {
        fields.insert(key.clone(), value.clone());
    }
    request.to_string()
}

/// Calls the plugin at `socket` with the request fields in `extra`.
pub fn ask(socket: &Path, extra: &Value) -> Result<Value, Failure> {
    let request = Request::parse(&request_json(socket, extra)).expect("a valid request");
    call(&request)
}

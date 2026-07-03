//! Dedicated OS thread that owns the `macmon::Sampler`.
//!
//! `macmon::Sampler` holds raw CoreFoundation pointers (IOReport / SMC / IOHID)
//! and is neither `Send` nor `Sync`, so it can never cross a thread boundary.
//! We pin it to a single worker thread and drive it over channels. The napi
//! `AsyncTask` layer (in `lib.rs`) sends `Cmd::Sample` from libuv threadpool
//! threads and blocks on a per-request response channel, keeping Node's main
//! event loop free while `get_metrics` sleeps for the sample interval.

use std::sync::mpsc::{channel, Receiver, Sender};

use crate::dto::{NativeMetrics, NativeSocInfo};

/// A request sent to the sampler worker thread.
pub enum Cmd {
    Sample {
        duration_ms: u32,
        resp: Sender<Result<NativeMetrics, String>>,
    },
}

/// Owns the channel to the worker thread plus the cached static SoC info.
///
/// The `JoinHandle` is intentionally *not* retained: joining could deadlock
/// because an in-flight `AsyncTask` holds a cloned `cmd_tx`, so the worker's
/// receive loop only ends once every sender (including in-flight ones) is
/// dropped. Detaching lets the thread drain naturally.
pub struct WorkerHandle {
    cmd_tx: Sender<Cmd>,
    soc: NativeSocInfo,
}

impl WorkerHandle {
    /// Spawn the worker and block on an init handshake so a failed
    /// `macmon::Sampler::new()` surfaces synchronously.
    pub fn new() -> Result<Self, String> {
        let (cmd_tx, cmd_rx) = channel::<Cmd>();
        let (init_tx, init_rx) = channel::<Result<NativeSocInfo, String>>();

        std::thread::Builder::new()
            .name("asmon-sampler".into())
            .spawn(move || run(cmd_rx, init_tx))
            .map_err(|e| format!("failed to spawn sampler thread: {e}"))?;

        match init_rx.recv() {
            Ok(Ok(soc)) => Ok(Self { cmd_tx, soc }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("sampler worker terminated before initializing".into()),
        }
    }

    /// Cached static SoC info (read once at init).
    pub fn soc(&self) -> NativeSocInfo {
        self.soc.clone()
    }

    /// A fresh sender for enqueueing a sample request.
    pub fn cmd_tx(&self) -> Sender<Cmd> {
        self.cmd_tx.clone()
    }
}

fn run(cmd_rx: Receiver<Cmd>, init_tx: Sender<Result<NativeSocInfo, String>>) {
    let mut sampler = match macmon::Sampler::new() {
        Ok(s) => s,
        Err(e) => {
            let _ = init_tx.send(Err(format!("SAMPLER_INIT_FAILED: {e}")));
            return;
        }
    };

    let soc = NativeSocInfo::from(sampler.get_soc_info());
    if init_tx.send(Ok(soc)).is_err() {
        // Constructor gave up waiting; nothing to serve.
        return;
    }
    drop(init_tx);

    // Ends when every `cmd_tx` clone (handle + any in-flight tasks) is dropped.
    for cmd in cmd_rx {
        match cmd {
            Cmd::Sample { duration_ms, resp } => {
                let result = sampler
                    .get_metrics(duration_ms)
                    .map(|m| NativeMetrics::from(&m))
                    .map_err(|e| format!("{e}"));
                let _ = resp.send(result);
            }
        }
    }
}

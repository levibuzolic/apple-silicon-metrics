//! N-API bindings for `apple-silicon-metrics`.
//!
//! This crate only ever builds for `darwin-arm64` (enforced by the npm package
//! `os`/`cpu` fields and by CI). The ergonomic, unit-normalized public API and
//! all null-normalization live in the TypeScript wrapper; this layer stays thin
//! and stable.

#[macro_use]
extern crate napi_derive;

mod dto;
mod membw;
mod thermal;
mod worker;

use std::sync::mpsc::{channel, Sender};

use napi::bindgen_prelude::*;

use crate::dto::{NativeMetrics, NativeSocInfo};
use crate::worker::{Cmd, WorkerHandle};

/// Cheap compile-time platform check. The TypeScript layer gates on
/// `process.platform` / `process.arch` before loading this addon, so on a
/// supported host this is effectively always `true`.
#[napi]
pub fn is_supported_native() -> bool {
    cfg!(all(target_os = "macos", target_arch = "aarch64"))
}

/// A long-lived sampler backed by a dedicated worker thread that owns the
/// `macmon::Sampler`.
#[napi]
pub struct Sampler {
    inner: Option<WorkerHandle>,
}

#[napi]
impl Sampler {
    /// Initialize the sampler. Blocks briefly on the worker init handshake so a
    /// sensor-initialization failure throws synchronously.
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        let handle =
            WorkerHandle::new().map_err(|e| Error::new(Status::GenericFailure, e))?;
        Ok(Self { inner: Some(handle) })
    }

    /// Static system-on-chip information (cheap, cached at init).
    #[napi]
    pub fn soc_info(&self) -> Result<NativeSocInfo> {
        match &self.inner {
            Some(h) => Ok(h.soc()),
            None => Err(closed_error()),
        }
    }

    /// Sample metrics, blocking on a worker thread (not the event loop) for
    /// roughly `duration_ms`. Resolves to a flat `NativeMetrics`.
    #[napi(ts_return_type = "Promise<NativeMetrics>")]
    pub fn sample(&self, duration_ms: u32) -> Result<AsyncTask<SampleTask>> {
        match &self.inner {
            Some(h) => Ok(AsyncTask::new(SampleTask {
                tx: h.cmd_tx(),
                duration_ms,
            })),
            None => Err(closed_error()),
        }
    }

    /// Release the worker thread. Subsequent calls throw. Idempotent.
    #[napi]
    pub fn close(&mut self) {
        // Dropping the handle drops its `cmd_tx`; the worker loop ends once all
        // senders (including any in-flight sample tasks) are gone.
        self.inner = None;
    }
}

fn closed_error() -> Error {
    Error::new(Status::GenericFailure, "SAMPLER_CLOSED: sampler is closed")
}

/// Runs a single blocking `get_metrics` on the libuv threadpool.
pub struct SampleTask {
    tx: Sender<Cmd>,
    duration_ms: u32,
}

impl Task for SampleTask {
    type Output = NativeMetrics;
    type JsValue = NativeMetrics;

    fn compute(&mut self) -> Result<Self::Output> {
        let (resp_tx, resp_rx) = channel();
        self.tx
            .send(Cmd::Sample {
                duration_ms: self.duration_ms,
                resp: resp_tx,
            })
            .map_err(|_| {
                Error::new(Status::GenericFailure, "SAMPLER_CLOSED: worker is not running")
            })?;

        match resp_rx.recv() {
            Ok(Ok(metrics)) => Ok(metrics),
            Ok(Err(e)) => Err(Error::new(Status::GenericFailure, e)),
            Err(_) => Err(Error::new(
                Status::GenericFailure,
                "SAMPLER_CLOSED: worker dropped the request",
            )),
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

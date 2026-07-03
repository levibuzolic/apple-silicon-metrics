//! Dedicated IOReport subscription for DRAM memory-bandwidth counters.
//!
//! `macmon` does not expose DRAM bandwidth and offers no hook into its own
//! IOReport subscription, so this module maintains a *separate* subscription
//! targeting the DRAM channel-stats ("DCS") read/write byte counters. It mirrors
//! macmon's create-subscription → sample → delta → iterate pattern (see the
//! pinned crate's `src/sources.rs`) but uses `IOReportCopyChannelsInGroup` to
//! subscribe to the memory-bandwidth group directly.
//!
//! ## Where the counters live
//!
//! On current Apple Silicon the DRAM byte counters are in the **`AMC Stats`**
//! group, subgroup `Perf Counters`, unit `B`: aggregate totals `DCS RD`/`DCS WR`
//! plus per-agent components (`ECPU0 DCS RD`, `GFX DCS WR`, …), per-frequency
//! breakdowns (`DCS F1 RD`) and real-time (`… RT DCS RD`) variants. To avoid
//! multiply-counting we prefer the aggregate `DCS RD`/`DCS WR` totals and only
//! fall back to summing the per-agent components when the aggregate is absent —
//! never mixing the two, and always excluding the frequency/RT subsets.
//!
//! ## Availability
//!
//! These `AMC Stats` counters are **privilege-gated** on current Apple Silicon:
//! the group is not independently subscribable and its channels never populate
//! in a sudo-less IOReport sample (this is the same data `powermetrics` exposes,
//! which requires root). Where that is the case this reader stays inert and
//! reports `0.0` (surfaced as `null` by the TypeScript layer). The full sampling
//! pipeline is exercised wherever the channels *are* sampleable, so no code here
//! fabricates a value. Nothing panics across the N-API boundary.
//!
//! The subscription owns raw CoreFoundation pointers and is neither `Send` nor
//! `Sync`; it MUST live on the same worker thread as `macmon::Sampler`. A
//! window's bandwidth is `delta_bytes / elapsed_seconds / 1e9` GB/s (decimal GB,
//! matching NeoAsitop).

#![allow(non_upper_case_globals)]

use std::marker::{PhantomData, PhantomPinned};
use std::mem::MaybeUninit;
use std::os::raw::c_void;
use std::ptr::{null, null_mut};
use std::time::Instant;

use core_foundation::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
use core_foundation::base::{kCFAllocatorDefault, kCFAllocatorNull, CFRelease, CFTypeRef};
use core_foundation::dictionary::{CFDictionaryGetValue, CFDictionaryRef, CFMutableDictionaryRef};
use core_foundation::string::{
    kCFStringEncodingUTF8, CFStringCreateWithBytesNoCopy, CFStringGetCString, CFStringRef,
};

/// IOReport channel groups that may carry the DRAM channel-stats counters. The
/// first is what current Apple Silicon exposes; the second is the historical
/// name other tooling documents, kept for forward/backward compatibility.
const DRAM_GROUPS: [&str; 2] = ["AMC Stats", "Memory Bandwidth"];

/// Sentinel returned by `IOReportSimpleGetIntegerValue` when a channel is not a
/// simple scalar (e.g. a state/distribution channel). Such values are skipped.
const IOREPORT_NOT_SCALAR: i64 = i64::MIN;

type CVoidRef = *const c_void;

#[repr(C)]
struct IOReportSubscription {
    _data: [u8; 0],
    _phantom: PhantomData<(*mut u8, PhantomPinned)>,
}

type IOReportSubscriptionRef = *const IOReportSubscription;

// FFI declarations adapted from macmon's `src/sources.rs`, plus the group-copy
// and merge entry points used to build a targeted subscription.
#[link(name = "IOReport", kind = "dylib")]
#[rustfmt::skip]
extern "C" {
    fn IOReportCopyChannelsInGroup(group: CFStringRef, subgroup: CFStringRef, a: u64, b: u64, c: u64) -> CFMutableDictionaryRef;
    fn IOReportMergeChannels(a: CFMutableDictionaryRef, b: CFDictionaryRef, c: CFTypeRef);
    fn IOReportCreateSubscription(a: CVoidRef, b: CFMutableDictionaryRef, c: *mut CFMutableDictionaryRef, d: u64, e: CFTypeRef) -> IOReportSubscriptionRef;
    fn IOReportCreateSamples(a: IOReportSubscriptionRef, b: CFMutableDictionaryRef, c: CFTypeRef) -> CFDictionaryRef;
    fn IOReportCreateSamplesDelta(a: CFDictionaryRef, b: CFDictionaryRef, c: CFTypeRef) -> CFDictionaryRef;
    fn IOReportChannelGetChannelName(a: CFDictionaryRef) -> CFStringRef;
    fn IOReportSimpleGetIntegerValue(a: CFDictionaryRef, b: i32) -> i64;
}

// MARK: CoreFoundation helpers (self-contained mirrors of macmon's cfutils)

fn cfstr(val: &str) -> CFStringRef {
    unsafe {
        CFStringCreateWithBytesNoCopy(
            kCFAllocatorDefault,
            val.as_ptr(),
            val.len() as isize,
            kCFStringEncodingUTF8,
            0,
            kCFAllocatorNull,
        )
    }
}

fn from_cfstr(val: CFStringRef) -> String {
    if val.is_null() {
        return String::new();
    }
    unsafe {
        let mut buf = vec![0i8; 128];
        if CFStringGetCString(val, buf.as_mut_ptr(), 128, kCFStringEncodingUTF8) == 0 {
            return String::new();
        }
        std::ffi::CStr::from_ptr(buf.as_ptr()).to_string_lossy().to_string()
    }
}

fn cfdict_get_val(dict: CFDictionaryRef, key: &str) -> Option<CFTypeRef> {
    unsafe {
        let key = cfstr(key);
        let val = CFDictionaryGetValue(dict, key as _);
        CFRelease(key as _);
        if val.is_null() {
            None
        } else {
            Some(val)
        }
    }
}

fn cfio_get_channel(item: CFDictionaryRef) -> String {
    from_cfstr(unsafe { IOReportChannelGetChannelName(item) })
}

/// Whether a byte counter is a DRAM read or write.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Read,
    Write,
}

/// Raw classification of a DCS byte channel.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Candidate {
    /// The `DCS RD` / `DCS WR` grand totals.
    Aggregate(Kind),
    /// A per-agent component such as `ECPU0 DCS RD`.
    Component(Kind),
    /// A DCS byte channel we deliberately do not count (frequency/RT subsets),
    /// or a channel that is not a DCS read/write byte counter at all.
    Ignore,
}

/// Classify a channel by its name. Only DCS *byte* counters ending in `RD`/`WR`
/// are candidates. Per-frequency (`DCS F1 RD`) and real-time (`… RT DCS RD`)
/// variants are subsets of the totals and are ignored to prevent double-counting.
fn classify(channel: &str) -> Candidate {
    let name = channel.trim().to_lowercase();

    let kind = if name.ends_with(" rd") {
        Kind::Read
    } else if name.ends_with(" wr") {
        Kind::Write
    } else {
        return Candidate::Ignore;
    };

    if !name.contains("dcs") {
        return Candidate::Ignore;
    }
    if name.contains("dcs f") || name.contains("rt dcs") || name.contains(" rt ") {
        return Candidate::Ignore;
    }
    if name == "dcs rd" || name == "dcs wr" {
        return Candidate::Aggregate(kind);
    }
    if name.ends_with(" dcs rd") || name.ends_with(" dcs wr") {
        return Candidate::Component(kind);
    }
    Candidate::Ignore
}

/// Active subscription state. Held behind an `Option` so a host lacking the
/// channels leaves the reader inert without any raw pointers to release.
struct Inner {
    subs: IOReportSubscriptionRef,
    /// The subscribed group channel dictionary, retained for sampling + release.
    chan: CFMutableDictionaryRef,
    /// Baseline sample plus the instant it was taken.
    baseline: Option<(CFDictionaryRef, Instant)>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        unsafe {
            if let Some((sample, _)) = self.baseline.take() {
                CFRelease(sample as _);
            }
            CFRelease(self.chan as _);
            CFRelease(self.subs as _);
        }
    }
}

/// A dedicated IOReport reader for DRAM memory bandwidth.
pub struct MemBandwidth {
    inner: Option<Inner>,
}

impl MemBandwidth {
    /// Create the subscription and capture an initial baseline. Never fails: a
    /// host that does not expose (or cannot sample) the DRAM DCS byte counters
    /// yields an inert reader that always reports `0.0`.
    pub fn new() -> Self {
        let inner = Self::try_new();
        let mut mb = Self { inner };
        mb.begin();
        mb
    }

    fn try_new() -> Option<Inner> {
        unsafe {
            // Build one channel dictionary spanning whichever DRAM group(s) exist
            // on this host, merging when more than one is present.
            let mut chan: CFMutableDictionaryRef = null_mut();
            for group in DRAM_GROUPS {
                let g = cfstr(group);
                let copied = IOReportCopyChannelsInGroup(g, null(), 0, 0, 0);
                CFRelease(g as _);
                if copied.is_null() {
                    continue;
                }
                let has_channels = cfdict_get_val(copied, "IOReportChannels")
                    .map(|arr| CFArrayGetCount(arr as CFArrayRef) > 0)
                    .unwrap_or(false);
                if !has_channels {
                    CFRelease(copied as _);
                    continue;
                }
                if chan.is_null() {
                    chan = copied;
                } else {
                    IOReportMergeChannels(chan, copied as CFDictionaryRef, null());
                    CFRelease(copied as _);
                }
            }
            if chan.is_null() {
                return None;
            }

            let mut s: MaybeUninit<CFMutableDictionaryRef> = MaybeUninit::uninit();
            let subs = IOReportCreateSubscription(null(), chan, s.as_mut_ptr(), 0, null());
            if subs.is_null() {
                CFRelease(chan as _);
                return None;
            }
            // Ownership of the out-dict follows macmon: assume-init and drop it.
            s.assume_init();

            Some(Inner { subs, chan, baseline: None })
        }
    }

    /// Capture a fresh baseline at the start of a sample window, releasing any
    /// previous unread baseline. Call this immediately before the interval sleep
    /// so the delta covers the same window macmon samples.
    pub fn begin(&mut self) {
        let Some(inner) = self.inner.as_mut() else {
            return;
        };
        let sample = unsafe { IOReportCreateSamples(inner.subs, inner.chan, null()) };
        if let Some((old, _)) = inner.baseline.take() {
            unsafe { CFRelease(old as _) };
        }
        if sample.is_null() {
            return;
        }
        inner.baseline = Some((sample, Instant::now()));
    }

    /// Read a fresh sample, delta it against the stored baseline, and return
    /// `(read_gbps, write_gbps)` over the elapsed window. The new sample becomes
    /// the next baseline. Returns `(0.0, 0.0)` when unavailable.
    pub fn read(&mut self) -> (f64, f64) {
        let Some(inner) = self.inner.as_mut() else {
            return (0.0, 0.0);
        };
        let Some((prev, started_at)) = inner.baseline.take() else {
            return (0.0, 0.0);
        };

        let sample = unsafe { IOReportCreateSamples(inner.subs, inner.chan, null()) };
        if sample.is_null() {
            // Keep the baseline so the next read can still produce a delta.
            inner.baseline = Some((prev, started_at));
            return (0.0, 0.0);
        }

        let elapsed = started_at.elapsed().as_secs_f64().max(1e-3);
        let delta = unsafe { IOReportCreateSamplesDelta(prev, sample, null()) };
        unsafe { CFRelease(prev as _) };
        inner.baseline = Some((sample, Instant::now()));

        if delta.is_null() {
            return (0.0, 0.0);
        }

        let (read_bytes, write_bytes) = sum_delta(delta);
        unsafe { CFRelease(delta as _) };

        (read_bytes / elapsed / 1e9, write_bytes / elapsed / 1e9)
    }
}

/// Sum a delta sample's DCS byte counters into `(read_bytes, write_bytes)`.
///
/// Prefers the aggregate `DCS RD`/`DCS WR` totals; falls back per-direction to
/// the sum of per-agent components when the aggregate is absent. Every delta
/// item belongs to a subscribed DRAM group, so classification is by channel name.
fn sum_delta(delta: CFDictionaryRef) -> (f64, f64) {
    let Some(items) = cfdict_get_val(delta, "IOReportChannels") else {
        return (0.0, 0.0);
    };
    let items = items as CFArrayRef;
    let count = unsafe { CFArrayGetCount(items) };

    let (mut agg_read, mut agg_write) = (0.0f64, 0.0f64);
    let (mut comp_read, mut comp_write) = (0.0f64, 0.0f64);
    let (mut saw_agg_read, mut saw_agg_write) = (false, false);

    for i in 0..count {
        let item = unsafe { CFArrayGetValueAtIndex(items, i) } as CFDictionaryRef;
        let raw = unsafe { IOReportSimpleGetIntegerValue(item, 0) };
        if raw == IOREPORT_NOT_SCALAR {
            continue;
        }
        let value = if raw < 0 { 0.0 } else { raw as f64 };

        match classify(&cfio_get_channel(item)) {
            Candidate::Aggregate(Kind::Read) => {
                agg_read += value;
                saw_agg_read = true;
            }
            Candidate::Aggregate(Kind::Write) => {
                agg_write += value;
                saw_agg_write = true;
            }
            Candidate::Component(Kind::Read) => comp_read += value,
            Candidate::Component(Kind::Write) => comp_write += value,
            Candidate::Ignore => {}
        }
    }

    let read = if saw_agg_read { agg_read } else { comp_read };
    let write = if saw_agg_write { agg_write } else { comp_write };
    (read, write)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_prefers_aggregate_totals() {
        assert_eq!(classify("DCS RD"), Candidate::Aggregate(Kind::Read));
        assert_eq!(classify("DCS WR"), Candidate::Aggregate(Kind::Write));
    }

    #[test]
    fn classify_recognizes_per_agent_components() {
        assert_eq!(classify("ECPU0 DCS RD"), Candidate::Component(Kind::Read));
        assert_eq!(classify("GFX DCS WR"), Candidate::Component(Kind::Write));
        assert_eq!(classify("PCPU1 DCS RD"), Candidate::Component(Kind::Read));
    }

    #[test]
    fn classify_ignores_frequency_realtime_and_non_dcs() {
        // Per-frequency and real-time variants are subsets of the totals.
        assert_eq!(classify("DCS F1 RD"), Candidate::Ignore);
        assert_eq!(classify("DISPEXT0 RT DCS RD"), Candidate::Ignore);
        // Non-DCS byte counters (e.g. the AF domain) and directionless channels.
        assert_eq!(classify("ECPU0 AF RD"), Candidate::Ignore);
        assert_eq!(classify("DCS CAS"), Candidate::Ignore);
        assert_eq!(classify("DCS"), Candidate::Ignore);
    }
}

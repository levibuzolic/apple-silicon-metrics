//! Coarse OS-level thermal-pressure signal.
//!
//! Reads `NSProcessInfo.thermalState` (via `objc2-foundation`), the same
//! system-wide thermal-pressure level surfaced to apps by macOS. This is *not*
//! an IOReport hardware counter: it is a discrete, throttling-oriented hint the
//! OS raises as the SoC heats up.
//!
//! Levels: 0 = nominal, 1 = fair, 2 = serious, 3 = critical. A level `>= 1`
//! means the OS has begun throttling to shed heat.

use objc2_foundation::NSProcessInfo;

/// Current OS thermal-pressure level as a raw `f64` in `0..=3`
/// (0 nominal, 1 fair, 2 serious, 3 critical).
///
/// Returned as `f64` to match the flat all-`f64` `NativeMetrics` DTO. The
/// `NSProcessInfoThermalState` enum only ever holds these four values, so the
/// cast is lossless.
pub fn thermal_pressure_level() -> f64 {
    let info = NSProcessInfo::processInfo();
    info.thermalState().0 as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_a_valid_level() {
        let level = thermal_pressure_level();
        assert!((0.0..=3.0).contains(&level), "level out of range: {level}");
        assert_eq!(level, level.trunc(), "level should be an integral value");
    }
}

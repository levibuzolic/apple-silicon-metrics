//! Flat, JS-facing data-transfer objects and conversions from `macmon` types.
//!
//! Raw `macmon` field names are intentionally *not* exposed. All numbers are
//! `f64` (u64 byte counts fit losslessly, avoiding awkward BigInt at the JS
//! boundary). Nullability is applied in the TypeScript layer, so unavailable
//! sensors are passed through here as their raw `0.0` and normalized to `null`
//! above the binding.

use napi_derive::napi;

/// Static, one-time system-on-chip information.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeSocInfo {
    pub chip_name: String,
    pub mac_model: String,
    pub memory_gb: f64,
    pub gpu_cores: f64,
    pub ecpu_cores: f64,
    pub pcpu_cores: f64,
}

/// A single fan's speed metrics. `max_rpm` is `None` when SMC does not report a
/// maximum for that fan.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeFan {
    pub name: String,
    pub rpm: f64,
    pub max_rpm: Option<f64>,
}

/// A single dynamic metrics sample. Flat by design; the TS layer reshapes this
/// into the nested public `Metrics` type and applies null-normalization.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeMetrics {
    // CPU
    pub cpu_usage_ratio: f64,
    pub cpu_power_watts: f64,
    pub cpu_temp_celsius: f64,
    // GPU
    pub gpu_usage_ratio: f64,
    pub gpu_freq_mhz: f64,
    pub gpu_power_watts: f64,
    pub gpu_temp_celsius: f64,
    // Memory (bytes)
    pub ram_total_bytes: f64,
    pub ram_used_bytes: f64,
    pub swap_total_bytes: f64,
    pub swap_used_bytes: f64,
    pub ram_power_watts: f64,
    // ANE
    pub ane_power_watts: f64,
    // Fans (empty when none are reported)
    pub fans: Vec<NativeFan>,
}

impl From<&macmon::SocInfo> for NativeSocInfo {
    fn from(soc: &macmon::SocInfo) -> Self {
        Self {
            chip_name: soc.chip_name.clone(),
            mac_model: soc.mac_model.clone(),
            memory_gb: soc.memory_gb as f64,
            gpu_cores: soc.gpu_cores as f64,
            ecpu_cores: soc.ecpu_cores as f64,
            pcpu_cores: soc.pcpu_cores as f64,
        }
    }
}

impl From<&macmon::Metrics> for NativeMetrics {
    fn from(m: &macmon::Metrics) -> Self {
        Self {
            cpu_usage_ratio: m.cpu_usage_pct as f64,
            cpu_power_watts: m.cpu_power as f64,
            cpu_temp_celsius: m.temp.cpu_temp_avg as f64,
            gpu_usage_ratio: m.gpu_usage.1 as f64,
            gpu_freq_mhz: m.gpu_usage.0 as f64,
            gpu_power_watts: m.gpu_power as f64,
            gpu_temp_celsius: m.temp.gpu_temp_avg as f64,
            ram_total_bytes: m.memory.ram_total as f64,
            ram_used_bytes: m.memory.ram_usage as f64,
            swap_total_bytes: m.memory.swap_total as f64,
            swap_used_bytes: m.memory.swap_usage as f64,
            ram_power_watts: m.ram_power as f64,
            ane_power_watts: m.ane_power as f64,
            fans: m.fans.iter().map(NativeFan::from).collect(),
        }
    }
}

impl From<&macmon::FanMetric> for NativeFan {
    fn from(f: &macmon::FanMetric) -> Self {
        Self {
            name: f.name.clone(),
            rpm: f.rpm as f64,
            max_rpm: f.max_rpm.map(|v| v as f64),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_metrics() -> macmon::Metrics {
        let mut m = macmon::Metrics::default();
        m.cpu_usage_pct = 0.42;
        m.cpu_power = 3.5;
        m.temp.cpu_temp_avg = 55.0;
        m.gpu_usage = (1200, 0.30);
        m.gpu_power = 2.0;
        m.temp.gpu_temp_avg = 0.0; // unavailable sensor
        m.memory.ram_total = 17_179_869_184; // 16 GiB
        m.memory.ram_usage = 8_589_934_592;
        m.memory.swap_total = 0;
        m.memory.swap_usage = 0;
        m.ram_power = 0.8;
        m.ane_power = 0.0;
        m
    }

    #[test]
    fn maps_metrics_fields() {
        let dto = NativeMetrics::from(&sample_metrics());
        assert_eq!(dto.cpu_usage_ratio, 0.42_f32 as f64);
        assert_eq!(dto.cpu_power_watts, 3.5_f32 as f64);
        assert_eq!(dto.cpu_temp_celsius, 55.0);
        assert_eq!(dto.gpu_usage_ratio, 0.30_f32 as f64);
        assert_eq!(dto.gpu_freq_mhz, 1200.0);
        assert_eq!(dto.gpu_temp_celsius, 0.0); // stays raw; TS normalizes to null
        assert_eq!(dto.ram_total_bytes, 17_179_869_184.0);
        assert_eq!(dto.ram_used_bytes, 8_589_934_592.0);
    }

    #[test]
    fn maps_fans() {
        let mut m = macmon::Metrics::default();
        m.fans = vec![
            macmon::FanMetric { name: "fan0".into(), rpm: 999, max_rpm: Some(4900) },
            macmon::FanMetric { name: "fan1".into(), rpm: 1200, max_rpm: None },
        ];
        let dto = NativeMetrics::from(&m);
        assert_eq!(dto.fans.len(), 2);
        assert_eq!(dto.fans[0].name, "fan0");
        assert_eq!(dto.fans[0].rpm, 999.0);
        assert_eq!(dto.fans[0].max_rpm, Some(4900.0));
        assert_eq!(dto.fans[1].max_rpm, None);
    }

    #[test]
    fn defaults_to_no_fans() {
        let dto = NativeMetrics::from(&macmon::Metrics::default());
        assert!(dto.fans.is_empty());
    }

    #[test]
    fn preserves_large_byte_counts_losslessly() {
        let mut m = macmon::Metrics::default();
        m.memory.ram_total = 206_158_430_208; // 192 GiB
        let dto = NativeMetrics::from(&m);
        assert_eq!(dto.ram_total_bytes as u64, 206_158_430_208);
    }

    #[test]
    fn maps_soc_info() {
        let soc = macmon::SocInfo {
            mac_model: "Mac15,3".into(),
            chip_name: "Apple M3".into(),
            memory_gb: 16,
            ecpu_cores: 4,
            pcpu_cores: 4,
            ecpu_label: "E".into(),
            pcpu_label: "P".into(),
            ecpu_freqs: vec![],
            pcpu_freqs: vec![],
            gpu_cores: 10,
            gpu_freqs: vec![],
        };
        let dto = NativeSocInfo::from(&soc);
        assert_eq!(dto.chip_name, "Apple M3");
        assert_eq!(dto.mac_model, "Mac15,3");
        assert_eq!(dto.memory_gb, 16.0);
        assert_eq!(dto.gpu_cores, 10.0);
        assert_eq!(dto.ecpu_cores, 4.0);
        assert_eq!(dto.pcpu_cores, 4.0);
    }
}

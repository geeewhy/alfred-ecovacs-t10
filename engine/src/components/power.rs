use async_trait::async_trait;
use serde_json::Value;
use tokio::process::Command;

pub struct BatterySnapshot {
    pub percent: u8,
    pub on_charger: bool,
}

#[async_trait]
pub trait BatterySnapshotSource: Send + Sync {
    async fn read(&self) -> Result<BatterySnapshot, String>;
}

pub struct NativeBatterySnapshot;

impl NativeBatterySnapshot {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl BatterySnapshotSource for NativeBatterySnapshot {
    async fn read(&self) -> Result<BatterySnapshot, String> {
        let output = Command::new("/usr/bin/mdsctl")
            .args(["rosnode", r#"{"todo":"rtctl","cmd":"getBatteryInfo"}"#])
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|error| format!("cannot query native battery snapshot: {error}"))?;
        let response: Value = serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("invalid native battery response: {error}"))?;
        if response.get("ret").and_then(Value::as_str) != Some("ok") {
            return Err("native battery snapshot was rejected".to_string());
        }
        let percent = response
            .get("battery")
            .and_then(Value::as_u64)
            .and_then(|value| u8::try_from(value).ok())
            .ok_or_else(|| "native battery response has no percentage".to_string())?
            .min(100);
        let on_charger = response
            .get("inCharging")
            .and_then(Value::as_u64)
            .map(|value| value != 0)
            .ok_or_else(|| "native battery response has no charging state".to_string())?;
        Ok(BatterySnapshot {
            percent,
            on_charger,
        })
    }
}

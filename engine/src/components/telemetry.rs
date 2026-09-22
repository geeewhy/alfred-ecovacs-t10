use crate::components::power::BatterySnapshotSource;
use crate::components::ros::{RosSubscriber, RosTopic};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;

const BATTERY_TOPIC: RosTopic = RosTopic {
    name: "/power/Battery",
    message_type: "power/Battery",
    md5: "1f868bac590fa9e653b61dc342b25421",
};
const CHARGE_TOPIC: RosTopic = RosTopic {
    name: "/power/ChargeState",
    message_type: "power/ChargeState",
    md5: "3f40efefe99d0b54d25afc2ed5523fc0",
};

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct BatteryStatus {
    pub percent: Option<u8>,
    pub low_voltage: Option<bool>,
    pub on_charger: Option<bool>,
    pub charge_state: Option<u8>,
    pub observed_at_unix: Option<u64>,
}

pub struct BatteryTelemetry {
    state: RwLock<BatteryStatus>,
    state_path: PathBuf,
    snapshot_source: Arc<dyn BatterySnapshotSource>,
}

impl BatteryTelemetry {
    pub async fn new(
        state_path: impl Into<PathBuf>,
        snapshot_source: Arc<dyn BatterySnapshotSource>,
    ) -> Arc<Self> {
        let state_path = state_path.into();
        let state = load(&state_path).await.unwrap_or_default();
        Arc::new(Self {
            state: RwLock::new(state),
            state_path,
            snapshot_source,
        })
    }

    pub async fn current(&self) -> BatteryStatus {
        self.state.read().await.clone()
    }

    pub fn start(self: &Arc<Self>) {
        let snapshot = Arc::clone(self);
        tokio::spawn(async move { snapshot.monitor_snapshot().await });
        let battery = Arc::clone(self);
        tokio::spawn(async move { battery.monitor_battery().await });
        let charge = Arc::clone(self);
        tokio::spawn(async move { charge.monitor_charge().await });
    }

    async fn monitor_snapshot(self: Arc<Self>) {
        loop {
            match self.snapshot_source.read().await {
                Ok(snapshot) => {
                    self.update_snapshot(snapshot.percent, snapshot.on_charger)
                        .await
                }
                Err(error) => eprintln!("battery snapshot retrying: {error}"),
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    }

    async fn monitor_battery(self: Arc<Self>) {
        loop {
            let service = Arc::clone(&self);
            let result = RosSubscriber::subscribe(&BATTERY_TOPIC, move |payload| {
                if payload.len() < 2 {
                    return Err("short ROS battery message".to_string());
                }
                let service = Arc::clone(&service);
                let percent = payload[0].min(100);
                let low_voltage = payload[1] != 0;
                tokio::spawn(async move {
                    service.update_battery(percent, low_voltage).await;
                });
                Ok(())
            })
            .await;
            if let Err(error) = result {
                eprintln!("battery subscriber reconnecting: {error}");
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    async fn monitor_charge(self: Arc<Self>) {
        loop {
            let service = Arc::clone(&self);
            let result = RosSubscriber::subscribe(&CHARGE_TOPIC, move |payload| {
                if payload.len() < 2 {
                    return Err("short ROS charge-state message".to_string());
                }
                let service = Arc::clone(&service);
                let on_charger = payload[0] != 0;
                let charge_state = payload[1];
                tokio::spawn(async move {
                    service.update_charge(on_charger, charge_state).await;
                });
                Ok(())
            })
            .await;
            if let Err(error) = result {
                eprintln!("charge-state subscriber reconnecting: {error}");
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    async fn update_battery(&self, percent: u8, low_voltage: bool) {
        let mut state = self.state.write().await;
        state.percent = Some(percent);
        state.low_voltage = Some(low_voltage);
        state.observed_at_unix = now();
        self.persist(&state).await;
    }

    async fn update_snapshot(&self, percent: u8, on_charger: bool) {
        let mut state = self.state.write().await;
        state.percent = Some(percent);
        state.on_charger = Some(on_charger);
        state.observed_at_unix = now();
        self.persist(&state).await;
    }

    async fn update_charge(&self, on_charger: bool, charge_state: u8) {
        let mut state = self.state.write().await;
        state.on_charger = Some(on_charger);
        state.charge_state = Some(charge_state);
        state.observed_at_unix = now();
        self.persist(&state).await;
    }

    async fn persist(&self, state: &BatteryStatus) {
        let Some(parent) = self.state_path.parent() else {
            return;
        };
        if tokio::fs::create_dir_all(parent).await.is_err() {
            return;
        }
        let Ok(contents) = serde_json::to_vec(state) else {
            return;
        };
        let temporary = self.state_path.with_extension("json.new");
        if tokio::fs::write(&temporary, contents).await.is_ok() {
            let _ = tokio::fs::rename(temporary, &self.state_path).await;
        }
    }
}

async fn load(path: &Path) -> Option<BatteryStatus> {
    let contents = tokio::fs::read(path).await.ok()?;
    serde_json::from_slice(&contents).ok()
}

fn now() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|value| value.as_secs())
}

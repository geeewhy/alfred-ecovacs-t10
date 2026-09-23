use crate::components::ros::{RosSubscriber, RosTopic};
use serde::Serialize;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const TOPIC: RosTopic = RosTopic {
    name: "/onOffInfo/OnOffInfo",
    publisher_node: "/node",
    message_type: "onOffInfo/OnOffInfo",
    md5: "27262bf10979dcfa4bad60d6c2b24ca7",
    max_frame_bytes: 4096,
};

#[derive(Clone, Default, Serialize)]
pub struct BumperStatus {
    pub left: Option<bool>,
    pub right: Option<bool>,
    pub raw: Option<u8>,
    pub cliff_raw: Option<u8>,
    pub wheel_lift_raw: Option<u8>,
    pub observed_at_unix_ms: Option<u64>,
    pub age_ms: Option<u64>,
    pub fresh: bool,
}

#[derive(Default)]
pub struct BumperTelemetry {
    state: RwLock<(BumperStatus, [Option<Instant>; 3])>,
}

impl BumperTelemetry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn current(&self) -> BumperStatus {
        let state = self.state.read().unwrap();
        let mut value = state.0.clone();
        value.age_ms = state.1[0].map(|at| at.elapsed().as_millis() as u64);
        value.fresh = value.age_ms.is_some_and(|age| age < 2000);
        if !value.fresh {
            value.left = None;
            value.right = None;
        }
        if !state.1[1].is_some_and(|at| at.elapsed() < Duration::from_secs(2)) {
            value.cliff_raw = None;
        }
        if !state.1[2].is_some_and(|at| at.elapsed() < Duration::from_secs(2)) {
            value.wheel_lift_raw = None;
        }
        value
    }

    fn update(&self, payload: &[u8]) -> Result<(), String> {
        let bumper = decode(payload)?;
        let cliff = sensor(payload, 1);
        let lift = sensor(payload, 2);
        let mut state = self.state.write().unwrap();
        let now = Instant::now();
        if let Some(raw) = bumper {
            state.0.raw = Some(raw);
            state.0.left = Some(raw & 1 != 0);
            state.0.right = Some(raw & 2 != 0);
            state.0.observed_at_unix_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()
                .map(|v| v.as_millis() as u64);
            state.1[0] = Some(now);
        }
        if let Some(raw) = cliff {
            state.0.cliff_raw = Some(raw);
            state.1[1] = Some(now);
        }
        if let Some(raw) = lift {
            state.0.wheel_lift_raw = Some(raw);
            state.1[2] = Some(now);
        }
        Ok(())
    }

    pub fn start(self: &Arc<Self>) {
        let service = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                let receiver = Arc::clone(&service);
                let result =
                    RosSubscriber::subscribe(&TOPIC, move |payload| receiver.update(payload)).await;
                if let Err(error) = result {
                    eprintln!("bumper subscriber reconnecting: {error}");
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
    }
}

fn sensor(payload: &[u8], kind: u8) -> Option<u8> {
    payload
        .get(4..)?
        .chunks_exact(2)
        .find(|entry| entry[0] == kind)
        .map(|entry| entry[1])
}

fn decode(payload: &[u8]) -> Result<Option<u8>, String> {
    let header: [u8; 4] = payload
        .get(..4)
        .ok_or("short on/off header")?
        .try_into()
        .unwrap();
    let count = u32::from_le_bytes(header) as usize;
    if count > (payload.len() - 4) / 2 || payload.len() != 4 + count * 2 {
        return Err("invalid on/off array length".into());
    }
    // TYPE_BUMP=0; BumpValue defines LEFT=0, RIGHT=1, LDS=2 bit indices.
    Ok(payload[4..]
        .chunks_exact(2)
        .find(|entry| entry[0] == 0)
        .map(|entry| entry[1]))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decodes_bumper_field_without_confusing_other_sensors() {
        assert_eq!(decode(&[3, 0, 0, 0, 3, 1, 0, 2, 1, 7]).unwrap(), Some(2));
        assert_eq!(decode(&[1, 0, 0, 0, 3, 1]).unwrap(), None);
        assert!(decode(&[2, 0, 0, 0, 0, 1]).is_err());
    }
    #[test]
    fn partial_updates_preserve_other_fresh_sensors_but_do_not_refresh_them() {
        let telemetry = BumperTelemetry::new();
        telemetry.update(&[3, 0, 0, 0, 0, 0, 1, 0, 2, 0]).unwrap();
        telemetry.update(&[1, 0, 0, 0, 0, 1]).unwrap();
        assert_eq!(telemetry.current().left, Some(true));
        assert_eq!(telemetry.current().cliff_raw, Some(0));
        assert_eq!(telemetry.current().wheel_lift_raw, Some(0));
        telemetry.state.write().unwrap().1[1] = Some(Instant::now() - Duration::from_secs(3));
        telemetry.update(&[1, 0, 0, 0, 0, 0]).unwrap();
        assert_eq!(telemetry.current().cliff_raw, None);
        assert_eq!(telemetry.current().wheel_lift_raw, Some(0));
        telemetry.update(&[1, 0, 0, 0, 1, 1]).unwrap();
        assert_eq!(telemetry.current().cliff_raw, Some(1));
    }
    #[test]
    fn stale_values_are_unknown_not_clear() {
        let telemetry = BumperTelemetry::new();
        assert_eq!(telemetry.current().left, None);
        *telemetry.state.write().unwrap() = (
            BumperStatus {
                left: Some(true),
                right: Some(false),
                ..Default::default()
            },
            [Some(Instant::now() - Duration::from_secs(3)), None, None],
        );
        let state = telemetry.current();
        assert!(!state.fresh);
        assert_eq!(state.left, None);
        assert_eq!(state.right, None);
    }
}

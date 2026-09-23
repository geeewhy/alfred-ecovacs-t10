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
    pub observed_at_unix_ms: Option<u64>,
    pub age_ms: Option<u64>,
    pub fresh: bool,
}

#[derive(Default)]
pub struct BumperTelemetry {
    state: RwLock<(BumperStatus, Option<Instant>)>,
}

impl BumperTelemetry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn current(&self) -> BumperStatus {
        let state = self.state.read().unwrap();
        let mut value = state.0.clone();
        value.age_ms = state.1.map(|at| at.elapsed().as_millis() as u64);
        value.fresh = value.age_ms.is_some_and(|age| age < 2000);
        if !value.fresh {
            value.left = None;
            value.right = None;
        }
        value
    }

    pub fn start(self: &Arc<Self>) {
        let service = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                let receiver = Arc::clone(&service);
                let result = RosSubscriber::subscribe(&TOPIC, move |payload| {
                    if let Some(raw) = decode(payload)? {
                        *receiver.state.write().unwrap() = (
                            BumperStatus {
                                left: Some(raw & 1 != 0),
                                right: Some(raw & 2 != 0),
                                raw: Some(raw),
                                observed_at_unix_ms: SystemTime::now()
                                    .duration_since(UNIX_EPOCH)
                                    .ok()
                                    .map(|v| v.as_millis() as u64),
                                age_ms: Some(0),
                                fresh: true,
                            },
                            Some(Instant::now()),
                        );
                    }
                    Ok(())
                })
                .await;
                if let Err(error) = result {
                    eprintln!("bumper subscriber reconnecting: {error}");
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
    }
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
    fn stale_values_are_unknown_not_clear() {
        let telemetry = BumperTelemetry::new();
        assert_eq!(telemetry.current().left, None);
        *telemetry.state.write().unwrap() = (
            BumperStatus {
                left: Some(true),
                right: Some(false),
                ..Default::default()
            },
            Some(Instant::now() - Duration::from_secs(3)),
        );
        let state = telemetry.current();
        assert!(!state.fresh);
        assert_eq!(state.left, None);
        assert_eq!(state.right, None);
    }
}

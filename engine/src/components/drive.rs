use crate::components::ros::{RosPublisher, RosTopic};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const WHEEL_TOPIC: RosTopic = RosTopic {
    name: "/wheel/SetWheelSpeed",
    publisher_node: "",
    message_type: "wheel/SetWheelSpeed",
    md5: "6136b114420b8e6600151ac57541e32e",
    max_frame_bytes: 64,
};
const DRIVE_SPEED_MM_S: f32 = 120.0;
const TURN_SPEED_MM_S: f32 = 70.0;
const DEADMAN: Duration = Duration::from_millis(350);

#[derive(Clone, Copy, Deserialize)]
pub struct DriveVector {
    pub linear: f32,
    pub angular: f32,
}

#[derive(Clone, Copy, Default, Serialize)]
pub struct DriveState {
    pub linear: f32,
    pub angular: f32,
    pub left_mm_s: f32,
    pub right_mm_s: f32,
    pub active: bool,
}

struct ActiveDrive {
    state: DriveState,
    deadline: Option<Instant>,
}

pub struct DriveService {
    publisher: Arc<RosPublisher>,
    active: Mutex<ActiveDrive>,
}

impl DriveService {
    pub async fn new() -> Result<Arc<Self>, String> {
        let publisher = RosPublisher::start(WHEEL_TOPIC).await?;
        let service = Arc::new(Self {
            publisher,
            active: Mutex::new(ActiveDrive {
                state: DriveState::default(),
                deadline: None,
            }),
        });
        let watchdog = Arc::clone(&service);
        tokio::spawn(async move { watchdog.watchdog().await });
        Ok(service)
    }

    pub async fn command(&self, vector: DriveVector) -> Result<DriveState, String> {
        if !valid_axis(vector.linear) || !valid_axis(vector.angular) {
            return Err("drive axes must be finite values from -1 to 1".to_string());
        }
        let (left_mm_s, right_mm_s) = mix(vector);
        self.publisher
            .publish(wheel_message(left_mm_s, right_mm_s))?;
        let state = DriveState {
            linear: vector.linear,
            angular: vector.angular,
            left_mm_s,
            right_mm_s,
            active: left_mm_s != 0.0 || right_mm_s != 0.0,
        };
        let mut active = self.active.lock().await;
        active.state = state;
        active.deadline = state.active.then(|| Instant::now() + DEADMAN);
        Ok(state)
    }

    pub async fn stop(&self) -> Result<DriveState, String> {
        self.command(DriveVector {
            linear: 0.0,
            angular: 0.0,
        })
        .await
    }

    async fn watchdog(&self) {
        loop {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let expired = {
                let active = self.active.lock().await;
                active
                    .deadline
                    .is_some_and(|deadline| Instant::now() >= deadline)
            };
            if expired && let Err(error) = self.stop().await {
                eprintln!("drive watchdog stop failed: {error}");
            }
        }
    }
}

fn valid_axis(value: f32) -> bool {
    value.is_finite() && (-1.0..=1.0).contains(&value)
}

fn mix(vector: DriveVector) -> (f32, f32) {
    if vector.linear == 0.0 {
        return (
            vector.angular * TURN_SPEED_MM_S,
            -vector.angular * TURN_SPEED_MM_S,
        );
    }
    let base = vector.linear * DRIVE_SPEED_MM_S;
    let turn = vector.angular * TURN_SPEED_MM_S;
    (
        (base + turn).clamp(-DRIVE_SPEED_MM_S, DRIVE_SPEED_MM_S),
        (base - turn).clamp(-DRIVE_SPEED_MM_S, DRIVE_SPEED_MM_S),
    )
}

fn wheel_message(left_mm_s: f32, right_mm_s: f32) -> Vec<u8> {
    let mut payload = Vec::with_capacity(13);
    payload.push(0);
    payload.extend_from_slice(&2_u32.to_le_bytes());
    payload.extend_from_slice(&left_mm_s.to_le_bytes());
    payload.extend_from_slice(&right_mm_s.to_le_bytes());
    payload
}

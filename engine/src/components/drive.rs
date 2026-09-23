use crate::components::ros::{RosPublisher, RosTopic, call_service};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const WHEEL_TOPIC: RosTopic = RosTopic {
    name: "/wheel/SetWheelSpeed",
    publisher_node: "",
    message_type: "wheel/SetWheelSpeed",
    md5: "6136b114420b8e6600151ac57541e32e",
    max_frame_bytes: 64,
};
const SETTINGS_PATH: &str = "/data/alfred/state/drive.json";

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DriveSettings {
    pub max_speed_mm_s: f32,
    pub turn_speed_mm_s: f32,
}
impl Default for DriveSettings {
    fn default() -> Self {
        Self {
            max_speed_mm_s: 300.0,
            turn_speed_mm_s: 180.0,
        }
    }
}
impl DriveSettings {
    fn validate(self) -> Result<Self, String> {
        if !self.max_speed_mm_s.is_finite()
            || self.max_speed_mm_s <= 0.0
            || !self.turn_speed_mm_s.is_finite()
            || self.turn_speed_mm_s <= 0.0
        {
            return Err("Speeds must be positive finite numbers in mm/s".into());
        }
        Ok(self)
    }
}
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
    settings: DriveSettings,
    deadline: Option<Instant>,
}

pub struct DriveService {
    publisher: Arc<RosPublisher>,
    active: Mutex<ActiveDrive>,
    wake_checked: Mutex<Option<Instant>>,
    stop_epoch: AtomicU64,
}

impl DriveService {
    pub async fn new() -> Result<Arc<Self>, String> {
        let publisher = RosPublisher::start(WHEEL_TOPIC).await?;
        let service = Arc::new(Self {
            publisher,
            wake_checked: Mutex::new(None),
            stop_epoch: AtomicU64::new(0),
            active: Mutex::new(ActiveDrive {
                state: DriveState::default(),
                settings: std::fs::read(SETTINGS_PATH)
                    .ok()
                    .and_then(|data| serde_json::from_slice::<DriveSettings>(&data).ok())
                    .and_then(|settings| settings.validate().ok())
                    .unwrap_or_default(),
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
        let started = Instant::now();
        let epoch = self.stop_epoch.load(Ordering::SeqCst);
        let moving = vector.linear != 0.0 || vector.angular != 0.0;
        if moving {
            self.ensure_awake().await?;
        } else {
            self.stop_epoch.fetch_add(1, Ordering::SeqCst);
        }
        let mut active = self.active.lock().await;
        if moving
            && (epoch != self.stop_epoch.load(Ordering::SeqCst) || started.elapsed() >= DEADMAN)
        {
            return Err("Drive request expired during wake; retry while held".into());
        }
        let (left_mm_s, right_mm_s) = mix(vector, active.settings);
        self.publisher
            .publish(wheel_message(left_mm_s, right_mm_s))?;
        let state = DriveState {
            linear: vector.linear,
            angular: vector.angular,
            left_mm_s,
            right_mm_s,
            active: left_mm_s != 0.0 || right_mm_s != 0.0,
        };
        active.state = state;
        active.deadline = state.active.then(|| Instant::now() + DEADMAN);
        Ok(state)
    }

    /// Only a sleeping robot receives native remote STOP. Never starts cleaning.
    pub async fn ensure_awake(&self) -> Result<(), String> {
        let mut checked = self
            .wake_checked
            .try_lock()
            .map_err(|_| "Robot wake check in progress")?;
        if checked.is_some_and(|at| at.elapsed() < Duration::from_secs(2)) {
            return Ok(());
        }
        let state = call_service(
            "/task/RobotManage",
            "cfd9e920d932894ddac5afdaed914536",
            &[1],
        )
        .await?;
        if state.as_slice() == [0, 0, 0, 0] {
            *checked = Some(Instant::now());
            return Ok(());
        }
        if state.as_slice() != [1, 0, 0, 0] {
            return Err("Unexpected native sleep state".into());
        }
        // Verified live WorkManage schema: manage, work, empty string, empty
        // CleanWorkData (45 bytes), ExtraWorkData with RemoteMove STOP.
        let mut request = vec![0_u8; 74];
        request[1] = 9; // WORK_TYPE_REMOTE_CONTROL
        request[59] = 2; // REMOTE_MOVE_STOP; duration and both speeds remain zero
        let reply = call_service(
            "/task/WorkManage",
            "02b48ec9983e0e81cc0e264c502c304b",
            &request,
        )
        .await?;
        if reply.as_slice() != [0] {
            return Err("Native wake request rejected".into());
        }
        // No motion until a subsequent call confirms awake. Stop remains immediate.
        Err("Robot waking; retry while held".into())
    }

    pub async fn settings(&self) -> DriveSettings {
        self.active.lock().await.settings
    }

    pub async fn save_settings(&self, settings: DriveSettings) -> Result<DriveSettings, String> {
        let settings = settings.validate()?;
        self.stop_epoch.fetch_add(1, Ordering::SeqCst);
        let mut active = self.active.lock().await;
        self.publisher.publish(wheel_message(0.0, 0.0))?;
        active.state = DriveState::default();
        active.deadline = None;
        tokio::fs::create_dir_all("/data/alfred/state")
            .await
            .map_err(|e| e.to_string())?;
        let data = serde_json::to_vec(&settings).map_err(|e| e.to_string())?;
        tokio::fs::write(format!("{SETTINGS_PATH}.tmp"), data)
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::rename(format!("{SETTINGS_PATH}.tmp"), SETTINGS_PATH)
            .await
            .map_err(|e| e.to_string())?;
        active.settings = settings;
        Ok(settings)
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
            let mut active = self.active.lock().await;
            if active
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
            {
                match self.publisher.publish(wheel_message(0.0, 0.0)) {
                    Ok(()) => {
                        active.state = DriveState::default();
                        active.deadline = None;
                    }
                    Err(error) => eprintln!("drive watchdog stop failed: {error}"),
                }
            }
        }
    }
}

fn valid_axis(value: f32) -> bool {
    value.is_finite() && (-1.0..=1.0).contains(&value)
}

fn mix(vector: DriveVector, settings: DriveSettings) -> (f32, f32) {
    if vector.linear == 0.0 {
        return (
            vector.angular * settings.turn_speed_mm_s,
            -vector.angular * settings.turn_speed_mm_s,
        );
    }
    let base = vector.linear * settings.max_speed_mm_s;
    // Scale steering with forward speed so raising the speed setting does not
    // flatten arcs. Equal held axes reduce the inside wheel to 25%, including
    // during the shared throttle ramp. Keep angular/yaw direction when reversing.
    let steering = (vector.angular.abs() / vector.linear.abs()).min(1.0);
    let inside = base * (1.0 - 0.75 * steering);
    if vector.angular.signum() == vector.linear.signum() {
        (base, inside)
    } else {
        (inside, base)
    }
}

fn wheel_message(left_mm_s: f32, right_mm_s: f32) -> Vec<u8> {
    let mut payload = Vec::with_capacity(13);
    // Firmware type 1 converts physical mm/s into encoder driving units.
    // Type 0 passes integers through (about 0.18013 mm per driving unit).
    payload.push(1);
    payload.extend_from_slice(&2_u32.to_le_bytes());
    payload.extend_from_slice(&left_mm_s.to_le_bytes());
    payload.extend_from_slice(&right_mm_s.to_le_bytes());
    payload
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn limits_validate_and_bound_mixed_commands() {
        assert!(
            DriveSettings {
                max_speed_mm_s: 0.0,
                turn_speed_mm_s: 180.0
            }
            .validate()
            .is_err()
        );
        assert!(
            DriveSettings {
                max_speed_mm_s: 200.0,
                turn_speed_mm_s: 250.0
            }
            .validate()
            .is_ok()
        );
        assert!(
            DriveSettings {
                max_speed_mm_s: f32::NAN,
                turn_speed_mm_s: 100.0
            }
            .validate()
            .is_err()
        );
        assert!(
            DriveSettings {
                max_speed_mm_s: 1200.0,
                turn_speed_mm_s: 800.0
            }
            .validate()
            .is_ok()
        );
        let settings = DriveSettings::default();
        assert_eq!(
            mix(
                DriveVector {
                    linear: 1.0,
                    angular: 1.0
                },
                settings
            ),
            (300.0, 75.0)
        );
        assert_eq!(
            mix(
                DriveVector {
                    linear: 0.0,
                    angular: 1.0
                },
                settings
            ),
            (180.0, -180.0)
        );
    }
    #[test]
    fn arcs_keep_steering_authority_across_speed_ramp_and_reverse() {
        let settings = DriveSettings {
            max_speed_mm_s: 1000.0,
            turn_speed_mm_s: 180.0,
        };
        for (linear, angular, expected) in [
            (1.0, -1.0, (250.0, 1000.0)),
            (1.0, 1.0, (1000.0, 250.0)),
            (0.2, -0.2, (50.0, 200.0)),
            (-1.0, -1.0, (-1000.0, -250.0)),
            (-1.0, 1.0, (-250.0, -1000.0)),
            (1.0, 0.0, (1000.0, 1000.0)),
            (0.0, 1.0, (180.0, -180.0)),
        ] {
            assert_eq!(mix(DriveVector { linear, angular }, settings), expected);
        }
    }

    #[test]
    fn wheel_wire_format_uses_physical_speed() {
        let payload = wheel_message(300.0, -180.0);
        assert_eq!(payload.len(), 13);
        assert_eq!(&payload[..5], &[1, 2, 0, 0, 0]);
        assert_eq!(f32::from_le_bytes(payload[5..9].try_into().unwrap()), 300.0);
        assert_eq!(
            f32::from_le_bytes(payload[9..13].try_into().unwrap()),
            -180.0
        );
    }
}

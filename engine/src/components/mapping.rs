//! Native firmware SLAM transport. Geometry remains in the firmware's map frame.
use super::ros::{RosPublisher, RosSubscriber, RosTopic};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::RwLock;

const MAP: RosTopic = RosTopic {
    name: "/slam/SlamMap",
    publisher_node: "/node",
    message_type: "slam/SlamMap",
    md5: "6f316e7cbf64fca0a845cd138238aaa6",
    max_frame_bytes: 4_000_028,
};
const CLOSE_MAP: RosTopic = RosTopic {
    name: "/slam/SlamCloseRangeMap",
    message_type: "slam/SlamCloseRangeMap",
    ..MAP
};
const BACKEND: RosTopic = RosTopic {
    name: "/slam/SlamBackendCounter",
    publisher_node: "/node",
    message_type: "slam/SlamBackendCounter",
    md5: "913deb8792c4e284c7a917272e561e1f",
    max_frame_bytes: 1,
};
const RELOCATION: RosTopic = RosTopic {
    name: "/slam/SlamMapRelocationResult",
    publisher_node: "/node",
    message_type: "slam/SlamMapRelocationResult",
    md5: "7c47dd5ecfcbdfce4c4eaf775f384ed4",
    max_frame_bytes: 2,
};
const BACKEND_STATE: RosTopic = RosTopic {
    name: "/slam/SlamBackendStatusChange",
    publisher_node: "/node",
    message_type: "slam/SlamBackendStatusChange",
    md5: "26fc5703332842f3367a4d45cf8d91b4",
    max_frame_bytes: 1,
};
const BACKEND_SCAN: RosTopic = RosTopic {
    name: "/lds/LdsWidthPose0",
    publisher_node: "/node",
    message_type: "lds/LdsWithPose",
    md5: "78795778359150b4c4c823c5334ce947",
    max_frame_bytes: 1_000_000,
};
const BACKEND_INPUT: RosTopic = RosTopic {
    name: "/lds/LdsWidthPose",
    publisher_node: "",
    ..BACKEND_SCAN
};
const WORK: RosTopic = RosTopic {
    name: "/task/WorkState",
    publisher_node: "/node",
    message_type: "task/WorkState",
    md5: "348557b1611751d82dc12e3b30ab551f",
    max_frame_bytes: 1_000_000,
};
const LOAD: RosTopic = RosTopic {
    name: "/slam/SlamMapControl",
    publisher_node: "",
    message_type: "slam/SlamMapControl",
    md5: "2b923dca442eeef2c39e99e9b5ae3029",
    max_frame_bytes: 8_000_057,
};
const POSE: RosTopic = RosTopic {
    name: "/prediction/PredictPose",
    publisher_node: "/node",
    message_type: "prediction/PredictPose",
    md5: "7b470216c350f9e55e9123b5b063d5d3",
    max_frame_bytes: 4096,
};
const WHEELS: RosTopic = RosTopic {
    name: "/wheel/WheelDistanceReport",
    publisher_node: "/node",
    message_type: "wheel/WheelDistanceReport",
    md5: "76589ac08503ec0ec947ad79c9cd2a4e",
    max_frame_bytes: 4096,
};
const CONTROL: RosTopic = RosTopic {
    name: "/slam/SlamControl",
    publisher_node: "",
    message_type: "slam/SlamControl",
    md5: "c9be73d65dd4236cf22404cc9f5f2843",
    max_frame_bytes: 1,
};

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct NativeGrid {
    pub sequence: u64,
    pub width: usize,
    pub height: usize,
    pub resolution: f32,
    pub origin: [f32; 2],
    /// Original unsigned firmware values, only nonzero cells. Semantics are decoded by HQ.
    pub cells: Vec<[u32; 3]>,
    pub age_ms: Option<u64>,
    #[serde(skip)]
    received: Option<Instant>,
}
#[derive(Clone, Default, Serialize)]
pub struct NativePose {
    pub x: f32,
    pub y: f32,
    pub theta: f32,
    pub stamp: f64,
    pub age_ms: Option<u64>,
    #[serde(skip)]
    received: Option<Instant>,
}
#[derive(Clone, Default, Serialize)]
pub struct WheelDistance {
    pub values: Vec<f32>,
    pub stamp: f64,
    pub age_ms: Option<u64>,
    #[serde(skip)]
    received: Option<Instant>,
}
#[derive(Serialize)]
pub struct NativeStatus {
    pub backend_enabled: bool,
    pub backend_frames: u64,
    pub reports: serde_json::Value,
    pub boot_id: String,
    pub pose: NativePose,
    pub wheels: WheelDistance,
    pub command: String,
}
#[derive(Serialize, Deserialize)]
pub struct NativeSnapshot {
    pub map: NativeGrid,
    pub close_map: NativeGrid,
}
pub struct NativeMapping {
    backend_input: Arc<RosPublisher>,
    backend_enabled: AtomicBool,
    backend_reset: AtomicBool,
    backend_frames: AtomicU64,
    close_grid: RwLock<NativeGrid>,
    reports: RwLock<serde_json::Value>,
    loader: Arc<RosPublisher>,
    grid: RwLock<NativeGrid>,
    pose: RwLock<NativePose>,
    wheels: RwLock<WheelDistance>,
    publisher: Arc<RosPublisher>,
    command: RwLock<String>,
    boot_id: String,
}
impl NativeMapping {
    pub async fn new() -> Result<Arc<Self>, String> {
        let this = Arc::new(Self {
            grid: RwLock::new(NativeGrid::default()),
            backend_input: RosPublisher::start(BACKEND_INPUT).await?,
            backend_enabled: AtomicBool::new(false),
            backend_reset: AtomicBool::new(false),
            backend_frames: AtomicU64::new(0),
            close_grid: RwLock::new(NativeGrid::default()),
            reports: RwLock::new(serde_json::json!({})),
            loader: RosPublisher::start(LOAD).await?,
            pose: RwLock::new(NativePose::default()),
            wheels: RwLock::new(WheelDistance::default()),
            publisher: RosPublisher::start(CONTROL).await?,
            command: RwLock::new("idle".into()),
            boot_id: std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
                .unwrap_or_default()
                .trim()
                .into(),
        });
        for topic in [
            MAP,
            CLOSE_MAP,
            POSE,
            WHEELS,
            BACKEND,
            RELOCATION,
            WORK,
            BACKEND_STATE,
            BACKEND_SCAN,
        ] {
            let owner = this.clone();
            tokio::spawn(async move {
                loop {
                    let receiver = owner.clone();
                    let result = RosSubscriber::subscribe(&topic, move |data| {
                        // Parse synchronously so malformed frames cannot replace valid state.
                        if topic.name == BACKEND_SCAN.name {
                            if !receiver.backend_enabled.load(Ordering::Acquire) { return Ok(()); }
                            validate_backend_scan(data)?;
                            let mut payload=data.to_vec();
                            if receiver.backend_reset.swap(false,Ordering::AcqRel) { *payload.last_mut().unwrap()=1; }
                            receiver.backend_input.publish(payload)?;
                            receiver.backend_frames.fetch_add(1,Ordering::Relaxed);
                        } else if topic.name == MAP.name || topic.name == CLOSE_MAP.name {
                            let mut value = parse_grid(data)?;
                            let receiver = receiver.clone();
                            tokio::spawn(async move {
                                let mut current = if topic.name == MAP.name { receiver.grid.write().await } else { receiver.close_grid.write().await };
                                value.sequence = current.sequence + 1;
                                *current = value;
                            });
                        } else if topic.name == POSE.name {
                            let value = parse_pose(data)?;
                            let receiver = receiver.clone();
                            tokio::spawn(async move {
                                *receiver.pose.write().await = value;
                            });
                        } else if topic.name == WHEELS.name {
                            let value = parse_wheels(data)?;
                            let receiver = receiver.clone();
                            tokio::spawn(async move {
                                *receiver.wheels.write().await = value;
                            });
                        } else {
                            if (topic.name == WORK.name && data.len() < 3) || (topic.name != WORK.name && data.len() != topic.max_frame_bytes) { return Err("Invalid SLAM report".into()); }
                            let value = if topic.name == WORK.name { data[..3].to_vec() } else { data.to_vec() }; let receiver = receiver.clone();
                            tokio::spawn(async move {
                                receiver.reports.write().await[topic.name] = serde_json::json!({"bytes":value,"received_unix_ms":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()});
                            });
                        }
                        Ok(())
                    })
                    .await;
                    if let Err(e) = result {
                        eprintln!("native mapping {}: {}", topic.name, e);
                    }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            });
        }
        Ok(this)
    }
    pub async fn control(&self, action: &str) -> Result<(), String> {
        if action == "backend-start" || action == "backend-resume" {
            self.backend_reset
                .store(action == "backend-start", Ordering::Release);
            self.backend_enabled.store(true, Ordering::Release);
            return Ok(());
        }
        if action == "backend-off" {
            self.backend_enabled.store(false, Ordering::Release);
            return Ok(());
        }
        let code = match action {
            "start" => 0,
            "stop" => 1,
            "pause" => 2,
            "resume" => 3,
            _ => return Err("Unknown SLAM action".into()),
        };
        self.publisher.publish(vec![code])?;
        *self.command.write().await = action.into();
        Ok(())
    }
    pub async fn snapshot(&self) -> NativeSnapshot {
        NativeSnapshot {
            map: self.grid().await,
            close_map: self.close_grid.read().await.clone(),
        }
    }
    pub async fn load(&self, snapshot: NativeSnapshot) -> Result<(), String> {
        let mut payload = vec![0];
        payload.extend(encode_grid(&snapshot.map)?);
        payload.extend(encode_grid(&snapshot.close_map)?);
        self.loader.publish(payload)?;
        *self.command.write().await = "load-requested".into();
        Ok(())
    }
    pub async fn grid(&self) -> NativeGrid {
        let mut v = self.grid.read().await.clone();
        v.age_ms = v.received.map(|t| t.elapsed().as_millis() as u64);
        v
    }
    pub async fn status(&self) -> NativeStatus {
        let mut pose = self.pose.read().await.clone();
        pose.age_ms = pose.received.map(|t| t.elapsed().as_millis() as u64);
        let mut wheels = self.wheels.read().await.clone();
        wheels.age_ms = wheels.received.map(|t| t.elapsed().as_millis() as u64);
        NativeStatus {
            backend_enabled: self.backend_enabled.load(Ordering::Acquire),
            backend_frames: self.backend_frames.load(Ordering::Relaxed),
            reports: self.reports.read().await.clone(),
            boot_id: self.boot_id.clone(),
            pose,
            wheels,
            command: self.command.read().await.clone(),
        }
    }
}
fn validate_backend_scan(b: &[u8]) -> Result<(), String> {
    let count = u32_at(b, 0)? as usize;
    if count > 20_000 {
        return Err("Oversized backend scan".into());
    }
    let mut at = 4 + count * 20;
    for _ in 0..3 {
        at = header(b, at)?.0 + 12;
    }
    if at + 1 != b.len() || b[at] > 1 {
        return Err("Invalid backend scan layout".into());
    }
    Ok(())
}
fn encode_grid(grid: &NativeGrid) -> Result<Vec<u8>, String> {
    let count = grid
        .width
        .checked_mul(grid.height)
        .ok_or("Map size overflow")?;
    if count == 0
        || count > 4_000_000
        || grid.width > u16::MAX as usize
        || grid.height > u16::MAX as usize
        || !grid.resolution.is_finite()
        || grid.resolution <= 0.
        || grid.origin.iter().any(|x| !x.is_finite())
    {
        return Err("Invalid saved map geometry".into());
    }
    let mut b = Vec::with_capacity(count + 28);
    b.extend((grid.width as u16).to_le_bytes());
    b.extend((grid.height as u16).to_le_bytes());
    for value in [
        grid.origin[0],
        grid.origin[0] + grid.width as f32 * grid.resolution,
        grid.origin[1],
        grid.origin[1] + grid.height as f32 * grid.resolution,
        grid.resolution,
    ] {
        b.extend((value * 1000.).to_le_bytes());
    }
    b.extend((count as u32).to_le_bytes());
    b.resize(count + 28, 0);
    for [x, y, value] in &grid.cells {
        if *x as usize >= grid.width || *y as usize >= grid.height || *value > 255 {
            return Err("Invalid saved map cell".into());
        }
        b[28 + *x as usize * grid.height + *y as usize] = *value as u8;
    }
    Ok(b)
}
fn u32_at(b: &[u8], at: usize) -> Result<u32, String> {
    Ok(u32::from_le_bytes(
        b.get(at..at + 4)
            .ok_or("Short native message")?
            .try_into()
            .unwrap(),
    ))
}
fn f32_at(b: &[u8], at: usize) -> Result<f32, String> {
    let v = f32::from_bits(u32_at(b, at)?);
    if !v.is_finite() {
        return Err("Nonfinite native value".into());
    }
    Ok(v)
}
fn header(b: &[u8], at: usize) -> Result<(usize, f64), String> {
    let end = at + 16 + u32_at(b, at + 12)? as usize;
    if end > b.len() {
        return Err("Short native header".into());
    }
    Ok((
        end,
        u32_at(b, at + 4)? as f64 + u32_at(b, at + 8)? as f64 / 1e9,
    ))
}
fn parse_pose(b: &[u8]) -> Result<NativePose, String> {
    let (first, _) = header(b, 0)?;
    let (at, stamp) = header(b, first + 12)?;
    Ok(NativePose {
        x: f32_at(b, at)? / 1000.,
        y: f32_at(b, at + 4)? / 1000.,
        theta: f32_at(b, at + 8)?,
        stamp,
        age_ms: Some(0),
        received: Some(Instant::now()),
    })
}
fn parse_wheels(b: &[u8]) -> Result<WheelDistance, String> {
    let (at, stamp) = header(b, 0)?;
    let count = u32_at(b, at)? as usize;
    if count != 2 {
        return Err("Expected two wheel distances".into());
    }
    Ok(WheelDistance {
        values: (0..count)
            .map(|i| f32_at(b, at + 4 + 4 * i))
            .collect::<Result<_, _>>()?,
        stamp,
        age_ms: Some(0),
        received: Some(Instant::now()),
    })
}
fn parse_grid(b: &[u8]) -> Result<NativeGrid, String> {
    if b.len() < 28 {
        return Err("Short native map".into());
    }
    let width = u16::from_le_bytes(b[0..2].try_into().unwrap()) as usize;
    let height = u16::from_le_bytes(b[2..4].try_into().unwrap()) as usize;
    let count = u32_at(b, 24)? as usize;
    if width == 0 || height == 0 || count != width * height || b.len() != 28 + count {
        return Err("Invalid native map dimensions".into());
    }
    let resolution = f32_at(b, 20)? / 1000.;
    if resolution <= 0. {
        return Err("Invalid map resolution".into());
    }
    let cells = b[28..]
        .iter()
        .enumerate()
        .filter(|(_, v)| **v != 0)
        .map(|(i, v)| [(i / height) as u32, (i % height) as u32, *v as u32])
        .collect();
    Ok(NativeGrid {
        width,
        height,
        resolution,
        origin: [f32_at(b, 4)? / 1000., f32_at(b, 12)? / 1000.],
        cells,
        age_ms: Some(0),
        received: Some(Instant::now()),
        ..Default::default()
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saved_maps_round_trip_without_transposing_or_changing_signed_evidence() {
        let grid = NativeGrid {
            width: 2,
            height: 3,
            resolution: 0.05,
            origin: [-1., 2.],
            cells: vec![[0, 2, 129], [1, 0, 127], [1, 2, 254]],
            ..Default::default()
        };
        let bytes = encode_grid(&grid).unwrap();
        assert_eq!(&bytes[28..], &[0, 0, 129, 127, 0, 254]);
        let decoded = parse_grid(&bytes).unwrap();
        assert_eq!(decoded.cells, grid.cells);
        assert_eq!(decoded.origin, grid.origin);
        let bad = NativeGrid {
            cells: vec![[2, 0, 129]],
            ..grid
        };
        assert!(encode_grid(&bad).is_err());
    }
    #[test]
    fn rejects_truncated_and_nonfinite_maps() {
        assert!(parse_grid(&[0; 27]).is_err());
        let mut b = vec![0; 29];
        b[0] = 1;
        b[2] = 1;
        b[24] = 1;
        b[20..24].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(parse_grid(&b).is_err());
    }
    #[test]
    fn preserves_unsigned_map_values_and_origin() {
        let mut b = vec![0; 32];
        b[0] = 2;
        b[2] = 2;
        b[24] = 4;
        b[20..24].copy_from_slice(&50f32.to_le_bytes());
        b[4..8].copy_from_slice(&(-1000f32).to_le_bytes());
        b[28] = 127;
        b[29] = 254;
        let g = parse_grid(&b).unwrap();
        assert_eq!(g.cells, vec![[0, 0, 127], [0, 1, 254]]);
        assert_eq!(g.origin[0], -1.);
    }
}

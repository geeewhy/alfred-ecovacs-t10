use crate::components::ros::{RosSubscriber, RosTopic};
use serde::Serialize;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;

const LIDAR_TOPIC: RosTopic = RosTopic {
    name: "/lds/Lds",
    publisher_node: "/node",
    message_type: "lds/Lds",
    md5: "ba4104feb5e50b9c15d3e29666224d02",
    max_frame_bytes: 128 * 1024,
};
const MAX_POINTS: usize = 720;

#[derive(Clone, Default, Serialize)]
pub struct LidarScan {
    pub sequence: u32,
    pub observed_at_unix_ms: u64,
    pub source_points: usize,
    pub points: Vec<LidarPoint>,
}

#[derive(Clone, Copy, Serialize)]
pub struct LidarPoint {
    pub x: f32,
    pub y: f32,
    pub power: f32,
}

pub struct LidarTelemetry {
    scan: RwLock<LidarScan>,
}

impl LidarTelemetry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            scan: RwLock::new(LidarScan::default()),
        })
    }

    pub async fn current(&self) -> LidarScan {
        self.scan.read().await.clone()
    }

    pub fn start(self: &Arc<Self>) {
        let service = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                let receiver = Arc::clone(&service);
                let result = RosSubscriber::subscribe(&LIDAR_TOPIC, move |payload| {
                    let scan = parse_scan(payload)?;
                    let receiver = Arc::clone(&receiver);
                    tokio::spawn(async move { *receiver.scan.write().await = scan });
                    Ok(())
                })
                .await;
                if let Err(error) = result {
                    eprintln!("lidar subscriber reconnecting: {error}");
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        });
    }
}

fn parse_scan(payload: &[u8]) -> Result<LidarScan, String> {
    let sequence = read_u32(payload, 0)?;
    let frame_length = read_u32(payload, 12)? as usize;
    let count_offset = 16_usize
        .checked_add(frame_length)
        .ok_or_else(|| "invalid ROS lidar header".to_string())?;
    let count = read_u32(payload, count_offset)? as usize;
    let points_offset = count_offset + 4;
    let required = points_offset
        .checked_add(count.saturating_mul(20))
        .ok_or_else(|| "invalid ROS lidar point count".to_string())?;
    if payload.len() < required {
        return Err("short ROS lidar message".to_string());
    }

    let stride = count.div_ceil(MAX_POINTS).max(1);
    let mut points = Vec::with_capacity(count.div_ceil(stride));
    for index in (0..count).step_by(stride) {
        let offset = points_offset + index * 20;
        let x = read_f32(payload, offset)?;
        let y = read_f32(payload, offset + 4)?;
        let power = read_f32(payload, offset + 16)?;
        if x.is_finite() && y.is_finite() && power.is_finite() {
            points.push(LidarPoint { x, y, power });
        }
    }

    Ok(LidarScan {
        sequence,
        observed_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_millis() as u64)
            .unwrap_or_default(),
        source_points: count,
        points,
    })
}

fn read_u32(payload: &[u8], offset: usize) -> Result<u32, String> {
    let bytes = payload
        .get(offset..offset + 4)
        .ok_or_else(|| "short ROS lidar field".to_string())?;
    Ok(u32::from_le_bytes(bytes.try_into().expect("four bytes")))
}

fn read_f32(payload: &[u8], offset: usize) -> Result<f32, String> {
    Ok(f32::from_bits(read_u32(payload, offset)?))
}

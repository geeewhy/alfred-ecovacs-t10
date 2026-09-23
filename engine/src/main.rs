mod components;
mod interface;

use components::audio::{AudioService, NativeAudio};
use components::bumpers::BumperTelemetry;
use components::camera::{CameraTelemetry, NativeCamera};
use components::clips::TempClipStore;
use components::drive::DriveService;
use components::lidar::LidarTelemetry;
use components::power::NativeBatterySnapshot;
use components::telemetry::BatteryTelemetry;
use interface::http::HttpRuntime;
use std::sync::Arc;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let backend = Arc::new(NativeAudio::new());
    let clips = Arc::new(TempClipStore::new("/tmp", 8));
    let audio = Arc::new(AudioService::new(backend, clips));
    let snapshot = Arc::new(NativeBatterySnapshot::new());
    let battery = BatteryTelemetry::new("/data/alfred/state/battery.json", snapshot).await;
    battery.start();
    let bumpers = BumperTelemetry::new();
    bumpers.start();
    let lidar = LidarTelemetry::new();
    lidar.start();
    let camera_source = Arc::new(NativeCamera::new("/tmp/alfred-camera.jpg"));
    let camera = CameraTelemetry::new(camera_source);
    camera.start();
    let drive = DriveService::new().await.map_err(std::io::Error::other)?;
    HttpRuntime::new(
        "127.0.0.1:8765",
        audio,
        battery,
        lidar,
        camera,
        drive,
        bumpers,
    )
    .run()
    .await
}

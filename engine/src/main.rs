mod components;
mod interface;

use components::audio::{AudioService, NativeAudio};
use components::clips::TempClipStore;
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
    HttpRuntime::new("127.0.0.1:8765", audio, battery)
        .run()
        .await
}

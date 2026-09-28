mod components;
mod interface;

use components::audio::{AudioService, NativeAudio};
use components::bumpers::BumperTelemetry;
use components::camera::{CameraTelemetry, NativeCamera};
use components::clips::TempClipStore;
use components::drive::DriveService;
use components::lidar::LidarTelemetry;
use components::mapping::NativeMapping;
use components::power::NativeBatterySnapshot;
use components::telemetry::BatteryTelemetry;
use interface::http::HttpRuntime;
use std::sync::Arc;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    // Offline replay mode never constructs ROS publishers or a motor service.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--mapping-evidence") {
        if args.len() != 4 {
            return Err(std::io::Error::other(
                "usage: --mapping-evidence REFERENCE_JSON HISTORY_JSON",
            ));
        }
        let reference =
            serde_json::from_slice(&std::fs::read(&args[2])?).map_err(std::io::Error::other)?;
        let map =
            components::map_evidence::EvidenceMap::new(reference).map_err(std::io::Error::other)?;
        let history: components::reflectance::History =
            serde_json::from_slice(&std::fs::read(&args[3])?).map_err(std::io::Error::other)?;
        for f in history.keyframes {
            let (s, c) = f.pose.theta.sin_cos();
            let points: Vec<_> = f
                .points
                .iter()
                .map(|p| {
                    let x = p[0] - f.pose.x;
                    let y = p[1] - f.pose.y;
                    [c * x + s * y, -s * x + c * y]
                })
                .collect();
            println!(
                "{}",
                serde_json::json!({"id":f.id,"evidence":map.evaluate(f.pose,&points)})
            );
        }
        return Ok(());
    }
    if args.get(1).map(String::as_str) == Some("--reflectance-rebuild") {
        if args.len() != 4 {
            return Err(std::io::Error::other(
                "usage: --reflectance-rebuild HISTORY_JSON OUTPUT_JSON",
            ));
        }
        let input =
            serde_json::from_slice(&std::fs::read(&args[2])?).map_err(std::io::Error::other)?;
        let result = components::reflectance::rebuild(input).map_err(std::io::Error::other)?;
        std::fs::write(
            &args[3],
            serde_json::to_vec(&result).map_err(std::io::Error::other)?,
        )?;
        println!(
            "{}",
            serde_json::to_string(&result.metrics).map_err(std::io::Error::other)?
        );
        return Ok(());
    }
    if args.get(1).map(String::as_str) == Some("--return-replay") {
        if args.len() != 4 {
            return Err(std::io::Error::other(
                "usage: --return-replay MAP_JSON SCAN_JSON",
            ));
        }
        let map =
            serde_json::from_slice(&std::fs::read(&args[2])?).map_err(std::io::Error::other)?;
        let geometry =
            components::return_geometry::Geometry::new(map).map_err(std::io::Error::other)?;
        let sample: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&args[3])?).map_err(std::io::Error::other)?;
        let points: Vec<[f64; 2]> = sample["points"]
            .as_array()
            .ok_or_else(|| std::io::Error::other("missing points"))?
            .iter()
            .filter_map(|p| {
                let x = p["x"].as_f64()? / 1000.;
                let y = p["y"].as_f64()? / 1000.;
                (p["power"].as_f64()? > 0. && x.hypot(y) > 0.25 && x.hypot(y) < 6.)
                    .then_some([x, y])
            })
            .step_by(4)
            .collect();
        let started = std::time::Instant::now();
        let found = geometry.locate(&points);
        let localization_ms = started.elapsed().as_millis();
        let near_points: Vec<[f64; 2]> = sample["points"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| {
                let x = p["x"].as_f64()? / 1000.;
                let y = p["y"].as_f64()? / 1000.;
                (p["power"].as_f64()? > 0. && x.hypot(y) > 0.06).then_some([x, y])
            })
            .collect();
        let near_started = std::time::Instant::now();
        let refined = found.and_then(|(pose, _)| geometry.refine_dock(pose, &near_points));
        println!(
            "{}",
            serde_json::json!({"matched":found,"elapsed_ms":localization_ms,"dock_refined":refined,"dock_refine_ms":near_started.elapsed().as_secs_f64()*1000.,"motion":false})
        );
        return Ok(());
    }
    let token = interface::auth::load_token("/data/alfred/engine-token")?;
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
    let mapping = NativeMapping::new().await.map_err(std::io::Error::other)?;
    HttpRuntime::new(
        "0.0.0.0:8765",
        token,
        audio,
        battery,
        lidar,
        camera,
        drive,
        bumpers,
        mapping,
    )
    .run()
    .await
}

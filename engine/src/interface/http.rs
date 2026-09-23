use crate::components::audio::AudioService;
use crate::components::bumpers::BumperTelemetry;
use crate::components::camera::CameraTelemetry;
use crate::components::drive::{
    DriveService, DriveSettings, DriveState, DriveVector, MappingTwist,
};
use crate::components::lidar::{LidarScan, LidarTelemetry};
use crate::components::mapping::{NativeMapping, NativeSnapshot};
use crate::components::telemetry::{BatteryStatus, BatteryTelemetry};
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use futures_util::TryStreamExt;
use serde::Serialize;
use std::io;
use std::sync::Arc;
use tokio_util::io::StreamReader;

const MAX_CLIP_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone)]
struct HttpState {
    audio: Arc<AudioService>,
    battery: Arc<BatteryTelemetry>,
    lidar: Arc<LidarTelemetry>,
    camera: Arc<CameraTelemetry>,
    drive: Arc<DriveService>,
    bumpers: Arc<BumperTelemetry>,
    mapping: Arc<NativeMapping>,
}

#[derive(Serialize)]
struct ApiResponse {
    ok: bool,
    result: String,
}

pub struct HttpRuntime {
    address: String,
    audio: Arc<AudioService>,
    battery: Arc<BatteryTelemetry>,
    lidar: Arc<LidarTelemetry>,
    camera: Arc<CameraTelemetry>,
    drive: Arc<DriveService>,
    bumpers: Arc<BumperTelemetry>,
    mapping: Arc<NativeMapping>,
}

impl HttpRuntime {
    pub fn new(
        address: impl Into<String>,
        audio: Arc<AudioService>,
        battery: Arc<BatteryTelemetry>,
        lidar: Arc<LidarTelemetry>,
        camera: Arc<CameraTelemetry>,
        drive: Arc<DriveService>,
        bumpers: Arc<BumperTelemetry>,
        mapping: Arc<NativeMapping>,
    ) -> Self {
        Self {
            address: address.into(),
            audio,
            battery,
            lidar,
            camera,
            drive,
            bumpers,
            mapping,
        }
    }

    pub async fn run(self) -> io::Result<()> {
        let state = HttpState {
            audio: self.audio,
            battery: self.battery,
            lidar: self.lidar,
            camera: self.camera,
            drive: self.drive,
            bumpers: self.bumpers,
            mapping: self.mapping,
        };
        let app = Router::new()
            .route("/health", get(health))
            .route("/v1/mapping/native/grid", get(native_grid))
            .route("/v1/mapping/native/snapshot", get(native_snapshot))
            .route("/v1/mapping/native/load", post(native_load))
            .route("/v1/mapping/native/status", get(native_status))
            .route("/v1/mapping/native/frame", get(native_frame))
            .route("/v1/mapping/native/{action}", post(native_control))
            .route("/v1/telemetry/battery", get(battery))
            .route("/v1/telemetry/bumpers", get(bumpers))
            .route("/v1/telemetry/lidar", get(lidar))
            .route("/v1/camera/frame", get(camera_frame))
            .route("/v1/drive", put(drive))
            .route("/v1/mapping/drive", put(mapping_drive))
            .route("/v1/mapping/twist", put(mapping_twist))
            .route(
                "/v1/drive/settings",
                get(drive_settings).put(save_drive_settings),
            )
            .route("/v1/drive/stop", post(stop_drive))
            .route("/v1/drive/wake", post(wake_drive))
            .route("/v1/audio/play", post(play))
            .route("/v1/audio/stock/{number}", post(stock))
            .route("/v1/audio/volume/{percent}", put(volume))
            .layer(DefaultBodyLimit::max(MAX_CLIP_BYTES))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind(&self.address).await?;
        eprintln!("alfred-engine listening on {}", self.address);
        axum::serve(listener, app).await
    }
}

#[derive(Serialize)]
struct TelemetryResponse {
    ok: bool,
    result: BatteryStatus,
}

#[derive(Serialize)]
struct LidarResponse {
    ok: bool,
    result: LidarScan,
}

async fn battery(State(state): State<HttpState>) -> Json<TelemetryResponse> {
    Json(TelemetryResponse {
        ok: true,
        result: state.battery.current().await,
    })
}

async fn lidar(State(state): State<HttpState>) -> Json<LidarResponse> {
    Json(LidarResponse {
        ok: true,
        result: state.lidar.current().await,
    })
}

async fn camera_frame(State(state): State<HttpState>) -> impl IntoResponse {
    let Some(frame) = state.camera.current().await else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            HeaderMap::new(),
            Vec::new(),
        );
    };
    let mut headers = HeaderMap::new();
    headers.insert("content-type", HeaderValue::from_static("image/jpeg"));
    insert_header(&mut headers, "x-frame-width", frame.width);
    insert_header(&mut headers, "x-frame-height", frame.height);
    insert_header(&mut headers, "x-observed-at", frame.observed_at_unix_ms);
    (StatusCode::OK, headers, frame.jpeg)
}

#[derive(Serialize)]
struct DriveResponse {
    ok: bool,
    result: DriveState,
}

async fn drive(
    State(state): State<HttpState>,
    Json(vector): Json<DriveVector>,
) -> Result<Json<DriveResponse>, (StatusCode, Json<ApiResponse>)> {
    drive_result(state.drive.command(vector).await)
}

async fn mapping_drive(
    State(state): State<HttpState>,
    Json(vector): Json<DriveVector>,
) -> Result<Json<DriveResponse>, (StatusCode, Json<ApiResponse>)> {
    if vector.linear != 0.0 || vector.angular != 0.0 {
        let sensors = state.bumpers.current();
        let scan = state.lidar.current().await;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let reason = mapping_vector_stop_reason(&sensors, &scan, now, &vector);
        if let Some(message) = reason {
            let _ = state.drive.stop().await;
            return Err(failure(StatusCode::CONFLICT, message));
        }
    }
    drive_result(state.drive.mapping_command(vector).await)
}

fn mapping_vector_stop_reason(
    sensors: &crate::components::bumpers::BumperStatus,
    scan: &LidarScan,
    now: u64,
    vector: &DriveVector,
) -> Option<&'static str> {
    // Front contact prevents forward/turn motion. A slow straight reverse
    // lets HQ release contact, with all other telemetry guards still checked.
    let reverse = vector.linear >= -0.25 && vector.linear < 0.0 && vector.angular == 0.0;
    if reverse && sensors.left.is_some() && sensors.right.is_some() {
        let mut released = sensors.clone();
        released.left = Some(false);
        released.right = Some(false);
        mapping_stop_reason(&released, scan, now)
    } else {
        mapping_stop_reason(sensors, scan, now)
    }
}

fn mapping_stop_reason(
    sensors: &crate::components::bumpers::BumperStatus,
    scan: &LidarScan,
    now: u64,
) -> Option<&'static str> {
    if !sensors.fresh || sensors.cliff_raw.is_none() || sensors.wheel_lift_raw.is_none() {
        Some("Mapping paused: safety sensors unavailable")
    } else if sensors.cliff_raw != Some(0) || sensors.wheel_lift_raw != Some(0) {
        Some("Mapping paused: cliff or lifted wheel detected")
    } else if sensors.left != Some(false) || sensors.right != Some(false) {
        Some("Mapping paused: front bumper pressed")
    } else if scan
        .age_ms
        .unwrap_or_else(|| now.saturating_sub(scan.observed_at_unix_ms))
        > 750
        || scan.points.len() < 60
    {
        Some("Mapping paused: LiDAR unavailable")
    } else {
        None
    }
}

async fn wake_drive(
    State(state): State<HttpState>,
) -> Result<Json<ApiResponse>, (StatusCode, Json<ApiResponse>)> {
    state
        .drive
        .ensure_awake()
        .await
        .map_err(|message| failure(StatusCode::SERVICE_UNAVAILABLE, message))?;
    Ok(success("Robot awake".into()))
}

async fn stop_drive(
    State(state): State<HttpState>,
) -> Result<Json<DriveResponse>, (StatusCode, Json<ApiResponse>)> {
    drive_result(state.drive.stop().await)
}

fn drive_result(
    value: Result<DriveState, String>,
) -> Result<Json<DriveResponse>, (StatusCode, Json<ApiResponse>)> {
    value
        .map(|result| Json(DriveResponse { ok: true, result }))
        .map_err(|message| failure(StatusCode::BAD_REQUEST, message))
}

fn insert_header(headers: &mut HeaderMap, name: &'static str, value: impl ToString) {
    if let Ok(value) = HeaderValue::from_str(&value.to_string()) {
        headers.insert(name, value);
    }
}

async fn health() -> Json<ApiResponse> {
    success(format!("alfred-engine/{}", env!("CARGO_PKG_VERSION")))
}

async fn play(State(state): State<HttpState>, headers: HeaderMap, body: Body) -> impl IntoResponse {
    let length = match headers
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    {
        Some(length) => length,
        None => return failure(StatusCode::LENGTH_REQUIRED, "Content-Length is required"),
    };
    let stream = body
        .into_data_stream()
        .map_err(|error| io::Error::other(error.to_string()));
    let mut reader = StreamReader::new(stream);
    result(state.audio.play_ogg(&mut reader, length).await)
}

async fn stock(State(state): State<HttpState>, Path(number): Path<u32>) -> impl IntoResponse {
    result(state.audio.stock(number).await)
}

async fn volume(State(state): State<HttpState>, Path(percent): Path<u32>) -> impl IntoResponse {
    result(state.audio.set_volume(percent).await)
}

fn result(value: Result<String, String>) -> (StatusCode, Json<ApiResponse>) {
    match value {
        Ok(message) => (StatusCode::OK, success(message)),
        Err(message) => failure(StatusCode::BAD_REQUEST, message),
    }
}

fn success(message: String) -> Json<ApiResponse> {
    Json(ApiResponse {
        ok: true,
        result: message,
    })
}

fn failure(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<ApiResponse>) {
    (
        status,
        Json(ApiResponse {
            ok: false,
            result: message.into(),
        }),
    )
}

#[derive(Serialize)]
struct DriveSettingsResponse {
    ok: bool,
    result: DriveSettings,
}
async fn drive_settings(State(state): State<HttpState>) -> Json<DriveSettingsResponse> {
    Json(DriveSettingsResponse {
        ok: true,
        result: state.drive.settings().await,
    })
}
async fn save_drive_settings(
    State(state): State<HttpState>,
    Json(settings): Json<DriveSettings>,
) -> Result<Json<DriveSettingsResponse>, (StatusCode, Json<ApiResponse>)> {
    state
        .drive
        .save_settings(settings)
        .await
        .map(|result| Json(DriveSettingsResponse { ok: true, result }))
        .map_err(|e| failure(StatusCode::BAD_REQUEST, e))
}

async fn bumpers(State(state): State<HttpState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({"ok": true, "result": state.bumpers.current()}))
}

#[cfg(test)]
mod mapping_tests {
    use super::*;
    use crate::components::bumpers::BumperStatus;
    use crate::components::lidar::LidarPoint;
    #[test]
    fn mapping_requires_clear_fresh_sensors_and_lidar() {
        let mut sensors = BumperStatus {
            fresh: true,
            cliff_raw: Some(0),
            wheel_lift_raw: Some(0),
            left: Some(false),
            right: Some(false),
            ..Default::default()
        };
        let scan = LidarScan {
            observed_at_unix_ms: 1000,
            points: vec![
                LidarPoint {
                    x: 1000.0,
                    y: 0.0,
                    power: 1.0
                };
                60
            ],
            ..Default::default()
        };
        assert!(mapping_stop_reason(&sensors, &scan, 1100).is_none());
        sensors.left = Some(true);
        assert!(mapping_stop_reason(&sensors, &scan, 1100).is_some());
        let reverse = DriveVector {
            linear: -0.25,
            angular: 0.0,
        };
        assert!(mapping_vector_stop_reason(&sensors, &scan, 1100, &reverse).is_none());
        assert!(mapping_vector_stop_reason(&sensors, &scan, 1800, &reverse).is_some());
        assert!(
            mapping_vector_stop_reason(
                &sensors,
                &scan,
                1100,
                &DriveVector {
                    linear: -0.5,
                    angular: 0.0
                }
            )
            .is_some()
        );
        assert!(
            mapping_vector_stop_reason(
                &sensors,
                &scan,
                1100,
                &DriveVector {
                    linear: 0.0,
                    angular: 0.5
                }
            )
            .is_some()
        );
        sensors.cliff_raw = Some(1);
        assert!(mapping_vector_stop_reason(&sensors, &scan, 1100, &reverse).is_some());
        sensors.left = Some(false);
        sensors.cliff_raw = Some(1);
        assert!(mapping_stop_reason(&sensors, &scan, 1100).is_some());
        sensors.cliff_raw = Some(0);
        sensors.wheel_lift_raw = None;
        assert!(mapping_stop_reason(&sensors, &scan, 1100).is_some());
        sensors.wheel_lift_raw = Some(0);
        assert!(mapping_stop_reason(&sensors, &scan, 1800).is_some());
        sensors.fresh = false;
        assert!(mapping_stop_reason(&sensors, &scan, 1100).is_some());
    }
}

async fn native_snapshot(State(state): State<HttpState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({"ok":true,"result":state.mapping.snapshot().await}))
}
async fn native_load(
    State(state): State<HttpState>,
    Json(snapshot): Json<NativeSnapshot>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiResponse>)> {
    state
        .drive
        .stop()
        .await
        .map_err(|e| failure(StatusCode::BAD_REQUEST, e))?;
    state
        .mapping
        .control("pause")
        .await
        .map_err(|e| failure(StatusCode::BAD_REQUEST, e))?;
    state
        .mapping
        .load(snapshot)
        .await
        .map_err(|e| failure(StatusCode::BAD_REQUEST, e))?;
    Ok(Json(
        serde_json::json!({"ok":true,"result":{"requested":true}}),
    ))
}
async fn native_grid(State(state): State<HttpState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({"ok":true,"result":state.mapping.grid().await}))
}
async fn native_status(State(state): State<HttpState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({"ok":true,"result":state.mapping.status().await}))
}
async fn native_control(
    State(state): State<HttpState>,
    Path(action): Path<String>,
) -> Result<Json<ApiResponse>, (StatusCode, Json<ApiResponse>)> {
    state.drive.stop().await.map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiResponse {
                ok: false,
                result: e,
            }),
        )
    })?;
    if action == "start" || action == "resume" {
        state.drive.ensure_awake().await.map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(ApiResponse {
                    ok: false,
                    result: e,
                }),
            )
        })?;
    }
    state.mapping.control(&action).await.map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiResponse {
                ok: false,
                result: e,
            }),
        )
    })?;
    Ok(success(format!("Native SLAM {action} sent")))
}

async fn mapping_twist(
    State(state): State<HttpState>,
    Json(value): Json<MappingTwist>,
) -> Result<Json<DriveResponse>, (StatusCode, Json<ApiResponse>)> {
    let vector = DriveVector {
        linear: value.linear_mm_s / 120.0,
        angular: value.angular_rad_s,
    };
    if vector.linear != 0.0 || vector.angular != 0.0 {
        let sensors = state.bumpers.current();
        let scan = state.lidar.current().await;
        if let Some(reason) = mapping_vector_stop_reason(&sensors, &scan, 0, &vector) {
            let _ = state.drive.stop().await;
            return Err(failure(StatusCode::CONFLICT, reason));
        }
    }
    drive_result(state.drive.mapping_twist(value).await)
}

async fn native_frame(State(state): State<HttpState>) -> Json<serde_json::Value> {
    Json(
        serde_json::json!({"ok":true,"result":{"native":state.mapping.status().await,"lidar":state.lidar.current().await,"bumpers":state.bumpers.current()}}),
    )
}

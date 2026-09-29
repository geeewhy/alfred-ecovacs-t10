use crate::components::audio::AudioService;
use crate::components::bumpers::BumperTelemetry;
use crate::components::camera::CameraTelemetry;
use crate::components::drive::{
    DriveService, DriveSettings, DriveState, DriveVector, MappingTwist,
};
use crate::components::lidar::{LidarScan, LidarTelemetry};
use crate::components::localization::{Config as LocalizationConfig, LocalizationService};
use crate::components::map_evidence::{EvidenceMap, Reference};
use crate::components::mapping::{NativeMapping, NativeSnapshot};
use crate::components::reflectance::{FilterRequest, Model, ReflectanceService};
use crate::components::return_geometry::ReturnMap;
use crate::components::return_to_station::{NavigationGoal, ReturnService};
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
    localization: Arc<LocalizationService>,
    reference: Arc<tokio::sync::RwLock<Option<Arc<EvidenceMap>>>>,
    reflectance: Arc<ReflectanceService>,
    returning: Arc<ReturnService>,
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
    token: String,
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
        token: String,
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
            token,
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
        let reflectance = ReflectanceService::new("/data/alfred/state/reflectance");
        let localization = LocalizationService::new(
            self.lidar.clone(),
            self.mapping.clone(),
            reflectance.clone(),
        )
        .await;
        let returning = ReturnService::new(
            self.drive.clone(),
            self.lidar.clone(),
            self.mapping.clone(),
            self.bumpers.clone(),
            reflectance.clone(),
            localization.clone(),
        )
        .await;
        let state = HttpState {
            localization,
            reference: Arc::new(tokio::sync::RwLock::new(None)),
            reflectance,
            returning,
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
            .route(
                "/v1/localization",
                get(localization_status).post(localization_start),
            )
            .route("/v1/localization/map", put(localization_install))
            .route("/v1/mapping/reference", put(reference_install))
            .route("/v1/mapping/evidence", post(reference_check))
            .route("/v1/mapping/reflectance/filter", post(reflection_filter))
            .route("/v1/mapping/reflectance/model", put(reflection_install))
            .route("/v1/mapping/reflectance/model/{id}", get(reflection_model))
            .route("/v1/navigation", get(return_status).post(start_navigation))
            .route("/v1/navigation/stop", post(stop_return))
            .route("/v1/return", get(return_status).post(start_return))
            .route("/v1/return/stop", post(stop_return))
            .route("/v1/return/config", put(return_config))
            .route("/v1/system/status", get(system_status))
            .route("/v1/telemetry/dock", get(dock_status))
            .route("/v1/drive/lidar-wake", post(lidar_wake))
            .route("/v1/drive/native-return/stop", post(native_return_stop))
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
            .with_state(state)
            .layer(axum::middleware::from_fn_with_state(
                self.token,
                super::auth::authorize,
            ));
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
    let _gate = state.returning.gate.lock().await;
    if state.returning.active().await {
        return Err(failure(
            StatusCode::CONFLICT,
            "Engine return owns motion; stop it before manual or HQ driving",
        ));
    }

    drive_result(state.drive.command(vector).await)
}

async fn mapping_drive(
    State(state): State<HttpState>,
    Json(vector): Json<DriveVector>,
) -> Result<Json<DriveResponse>, (StatusCode, Json<ApiResponse>)> {
    let _gate = state.returning.gate.lock().await;
    if state.returning.active().await {
        return Err(failure(
            StatusCode::CONFLICT,
            "Engine return owns motion; stop it before manual or HQ driving",
        ));
    }

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
    let _gate = state.returning.gate.lock().await;
    state
        .returning
        .stop()
        .await
        .map_err(|e| failure(StatusCode::SERVICE_UNAVAILABLE, e))?;

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
    let _gate = state.returning.gate.lock().await;
    if state.returning.active().await {
        return Err(failure(
            StatusCode::CONFLICT,
            "Stop onboard return before changing native mapping",
        ));
    }

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
    let _gate = state.returning.gate.lock().await;
    if state.returning.active().await {
        return Err(failure(
            StatusCode::CONFLICT,
            "Stop onboard return before changing native mapping",
        ));
    }

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
    let _gate = state.returning.gate.lock().await;
    if state.returning.active().await {
        return Err(failure(
            StatusCode::CONFLICT,
            "Engine return owns motion; stop it before manual or HQ driving",
        ));
    }

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
        serde_json::json!({"ok":true,"result":{"native":state.mapping.status().await,"lidar":state.lidar.current().await,"bumpers":state.bumpers.current(),"localization":state.localization.status().await}}),
    )
}

async fn fixed_command(program: &str, args: &[&str]) -> Result<String, String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(6),
        tokio::process::Command::new(program)
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "Native request timed out".to_string())?
    .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("Native request failed".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
async fn system_status(State(state): State<HttpState>) -> impl IntoResponse {
    match fixed_command(
        "/bin/sh",
        &["-c", include_str!("../../../runtime/status.sh")],
    )
    .await
    {
        Ok(mut raw) => {
            let battery = state.battery.current().await;
            raw.push_str(&format!(
                "BATTERY_JSON={}\n",
                serde_json::json!({"result":battery})
            ));
            (
                StatusCode::OK,
                Json(serde_json::json!({"ok":true,"result":raw})),
            )
        }
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"ok":false,"result":error})),
        ),
    }
}
async fn dock_status() -> impl IntoResponse {
    use crate::components::power::{BatterySnapshotSource, NativeBatterySnapshot};
    match tokio::time::timeout(
        std::time::Duration::from_millis(1500),
        NativeBatterySnapshot::new().read(),
    )
    .await
    {
        Ok(Ok(value)) => (
            StatusCode::OK,
            Json(serde_json::json!({"ok":true,"result":{
            "docked":value.on_charger,"percent":value.percent,
            "observedAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
            "source":"native-charging-contact"}})),
        ),
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"ok":false,"result":"Charging telemetry unavailable"})),
        ),
    }
}
async fn lidar_wake() -> impl IntoResponse {
    result(fixed_command("python", &["/data/alfred/lidar_start.py"]).await)
}
async fn native_return_stop(State(state): State<HttpState>) -> impl IntoResponse {
    if let Err(error) = state.drive.stop().await {
        return result(Err(error));
    }
    result(fixed_command("python", &["/data/alfred/map_bridge.py", "stop-return"]).await)
}

async fn return_status(State(state): State<HttpState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({"ok":true,"result":state.returning.status().await}))
}
async fn start_navigation(
    State(state): State<HttpState>,
    Json(goal): Json<NavigationGoal>,
) -> impl IntoResponse {
    let _gate = state.returning.gate.lock().await;
    result(
        state
            .returning
            .navigate(goal)
            .await
            .map(|_| "Engine navigation started".into()),
    )
}
async fn start_return(State(state): State<HttpState>) -> impl IntoResponse {
    let _gate = state.returning.gate.lock().await;
    result(
        state
            .returning
            .start()
            .await
            .map(|_| "Engine return started".into()),
    )
}
async fn stop_return(State(state): State<HttpState>) -> impl IntoResponse {
    let _gate = state.returning.gate.lock().await;
    result(
        state
            .returning
            .stop()
            .await
            .map(|_| "Engine return stopped".into()),
    )
}
async fn return_config(
    State(state): State<HttpState>,
    Json(map): Json<ReturnMap>,
) -> impl IntoResponse {
    let _gate = state.returning.gate.lock().await;
    result(
        state
            .returning
            .configure(map)
            .await
            .map(|_| "Onboard return map installed".into()),
    )
}

async fn reflection_filter(
    State(state): State<HttpState>,
    Json(input): Json<FilterRequest>,
) -> impl IntoResponse {
    let value = async {
        input.validate()?;
        let model = state.reflectance.load(&input.map_id).await?;
        Ok::<_, String>(model.filter(input.pose, &input.points))
    }
    .await;
    match value {
        Ok(value) => (
            StatusCode::OK,
            Json(serde_json::json!({"ok":true,"result":value})),
        ),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"ok":false,"result":e})),
        ),
    }
}
async fn reflection_model(
    State(state): State<HttpState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.reflectance.load(&id).await {
        Ok(value) => (
            StatusCode::OK,
            Json(serde_json::json!({"ok":true,"result":value.model})),
        ),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"ok":false,"result":e})),
        ),
    }
}
async fn reflection_install(
    State(state): State<HttpState>,
    Json(input): Json<Model>,
) -> impl IntoResponse {
    let _gate = state.returning.gate.lock().await;
    if state.returning.active().await {
        return (
            StatusCode::CONFLICT,
            Json(
                serde_json::json!({"ok":false,"result":"Finish or stop onboard return before replacing its reflection model"}),
            ),
        );
    }
    match state.reflectance.install(input).await {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({"ok":true,"result":"installed"})),
        ),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"ok":false,"result":e})),
        ),
    }
}

async fn reference_install(
    State(state): State<HttpState>,
    Json(input): Json<Reference>,
) -> impl IntoResponse {
    match EvidenceMap::new(input) {
        Ok(map) => {
            *state.reference.write().await = Some(Arc::new(map));
            (
                StatusCode::OK,
                Json(serde_json::json!({"ok":true,"result":"Reference installed"})),
            )
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"ok":false,"error":e})),
        ),
    }
}
async fn reference_check(
    State(state): State<HttpState>,
    Json(input): Json<FilterRequest>,
) -> impl IntoResponse {
    let map = state.reference.read().await.clone();
    let checked = map
        .ok_or_else(|| "Mapping reference not installed".to_string())
        .and_then(|m| m.check(&input));
    match checked {
        Ok(v) => (
            StatusCode::OK,
            Json(serde_json::json!({"ok":true,"result":v})),
        ),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"ok":false,"error":e})),
        ),
    }
}

async fn localization_status(State(state): State<HttpState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({"ok":true,"result":state.localization.status().await}))
}
async fn localization_install(
    State(state): State<HttpState>,
    Json(config): Json<LocalizationConfig>,
) -> impl IntoResponse {
    let _gate = state.returning.gate.lock().await;
    if state.returning.active().await {
        return result(Err("Stop return before replacing localization map".into()));
    }
    result(
        state
            .localization
            .install(config)
            .await
            .map(|_| "Localization map installed".into()),
    )
}
#[derive(serde::Deserialize)]
struct LocateRequest {
    map_id: String,
}
async fn localization_start(
    State(state): State<HttpState>,
    Json(request): Json<LocateRequest>,
) -> impl IntoResponse {
    let _gate = state.returning.gate.lock().await;
    if state.returning.active().await {
        return result(Err("Stop return before resetting localization".into()));
    }
    if !state
        .lidar
        .current()
        .await
        .age_ms
        .is_some_and(|age| age < 750)
    {
        if let Err(error) = fixed_command("python", &["/data/alfred/lidar_start.py"]).await {
            return result(Err(error));
        }
    }
    result(
        state
            .localization
            .locate(&request.map_id)
            .await
            .map(|_| "Engine localization started".into()),
    )
}

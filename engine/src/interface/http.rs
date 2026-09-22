use crate::components::audio::AudioService;
use crate::components::camera::CameraTelemetry;
use crate::components::lidar::{LidarScan, LidarTelemetry};
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
}

impl HttpRuntime {
    pub fn new(
        address: impl Into<String>,
        audio: Arc<AudioService>,
        battery: Arc<BatteryTelemetry>,
        lidar: Arc<LidarTelemetry>,
        camera: Arc<CameraTelemetry>,
    ) -> Self {
        Self {
            address: address.into(),
            audio,
            battery,
            lidar,
            camera,
        }
    }

    pub async fn run(self) -> io::Result<()> {
        let state = HttpState {
            audio: self.audio,
            battery: self.battery,
            lidar: self.lidar,
            camera: self.camera,
        };
        let app = Router::new()
            .route("/health", get(health))
            .route("/v1/telemetry/battery", get(battery))
            .route("/v1/telemetry/lidar", get(lidar))
            .route("/v1/camera/frame", get(camera_frame))
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

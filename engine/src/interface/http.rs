use crate::components::audio::AudioService;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode};
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
}

#[derive(Serialize)]
struct ApiResponse {
    ok: bool,
    result: String,
}

pub struct HttpRuntime {
    address: String,
    audio: Arc<AudioService>,
}

impl HttpRuntime {
    pub fn new(address: impl Into<String>, audio: Arc<AudioService>) -> Self {
        Self {
            address: address.into(),
            audio,
        }
    }

    pub async fn run(self) -> io::Result<()> {
        let state = HttpState { audio: self.audio };
        let app = Router::new()
            .route("/health", get(health))
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

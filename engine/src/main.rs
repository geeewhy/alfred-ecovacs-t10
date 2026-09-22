mod components;
mod interface;

use components::audio::{AudioService, NativeAudio};
use components::clips::TempClipStore;
use interface::http::HttpRuntime;
use std::sync::Arc;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let backend = Arc::new(NativeAudio::new());
    let clips = Arc::new(TempClipStore::new("/tmp", 8));
    let audio = Arc::new(AudioService::new(backend, clips));
    HttpRuntime::new("127.0.0.1:8765", audio).run().await
}

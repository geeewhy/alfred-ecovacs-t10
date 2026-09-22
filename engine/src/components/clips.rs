use async_trait::async_trait;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::fs::{self, OpenOptions};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

const MAX_CLIP_BYTES: u64 = 16 * 1024 * 1024;

#[async_trait]
pub trait ClipStore: Send + Sync {
    async fn receive_ogg(
        &self,
        source: &mut (dyn AsyncRead + Unpin + Send),
        length: u64,
    ) -> Result<PathBuf, String>;
    async fn retain(&self, path: PathBuf);
    async fn discard(&self, path: &Path);
}

pub struct TempClipStore {
    directory: PathBuf,
    retained_limit: usize,
    sequence: AtomicU64,
    retained: Mutex<VecDeque<PathBuf>>,
}

impl TempClipStore {
    pub fn new(directory: impl Into<PathBuf>, retained_limit: usize) -> Self {
        Self {
            directory: directory.into(),
            retained_limit,
            sequence: AtomicU64::new(0),
            retained: Mutex::new(VecDeque::new()),
        }
    }

    fn next_path(&self) -> PathBuf {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        self.directory.join(format!(
            "alfred-stream-{}-{sequence}.ogg",
            std::process::id()
        ))
    }
}

#[async_trait]
impl ClipStore for TempClipStore {
    async fn receive_ogg(
        &self,
        source: &mut (dyn AsyncRead + Unpin + Send),
        length: u64,
    ) -> Result<PathBuf, String> {
        if !(4..=MAX_CLIP_BYTES).contains(&length) {
            return Err(format!("clip length must be 4..={MAX_CLIP_BYTES}"));
        }
        let path = self.next_path();
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
            .map_err(|error| format!("cannot create clip: {error}"))?;
        let mut remaining = length;
        let mut buffer = [0_u8; 32 * 1024];
        let mut prefix = Vec::with_capacity(4);
        while remaining > 0 {
            let wanted = usize::try_from(remaining.min(buffer.len() as u64)).unwrap();
            source
                .read_exact(&mut buffer[..wanted])
                .await
                .map_err(|error| format!("short clip stream: {error}"))?;
            if prefix.len() < 4 {
                let take = (4 - prefix.len()).min(wanted);
                prefix.extend_from_slice(&buffer[..take]);
            }
            file.write_all(&buffer[..wanted])
                .await
                .map_err(|error| format!("cannot write clip: {error}"))?;
            remaining -= wanted as u64;
        }
        file.flush()
            .await
            .map_err(|error| format!("cannot flush clip: {error}"))?;
        if prefix != b"OggS" {
            self.discard(&path).await;
            return Err("body must be an Ogg stream".to_string());
        }
        Ok(path)
    }

    async fn retain(&self, path: PathBuf) {
        let mut retained = self.retained.lock().await;
        retained.push_back(path);
        while retained.len() > self.retained_limit {
            if let Some(old) = retained.pop_front() {
                self.discard(&old).await;
            }
        }
    }

    async fn discard(&self, path: &Path) {
        let _ = fs::remove_file(path).await;
    }
}

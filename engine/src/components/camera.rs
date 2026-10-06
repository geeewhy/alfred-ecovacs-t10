use async_trait::async_trait;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::Command;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct CameraFrame {
    pub width: u32,
    pub height: u32,
    pub observed_at_unix_ms: u64,
    pub jpeg: Vec<u8>,
}

#[async_trait]
pub trait CameraFrameSource: Send + Sync {
    async fn capture(&self) -> Result<CameraFrame, String>;
}

pub struct NativeCamera {
    path: PathBuf,
    started: AtomicBool,
}

impl NativeCamera {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            started: AtomicBool::new(false),
        }
    }

    async fn ensure_started(&self) -> Result<(), String> {
        if self.started.load(Ordering::Acquire) {
            return Ok(());
        }
        mdsctl("camera0", r#"{"todo":"start_vps_chn1"}"#).await?;
        mdsctl("venc", r#"{"todo":"start_enc","level":2}"#).await?;
        self.started.store(true, Ordering::Release);
        Ok(())
    }
}

#[async_trait]
impl CameraFrameSource for NativeCamera {
    async fn capture(&self) -> Result<CameraFrame, String> {
        self.ensure_started().await?;
        let path = self
            .path
            .to_str()
            .ok_or_else(|| "camera frame path is not UTF-8".to_string())?;
        let request = format!(r#"{{"todo":"take_photo","path":"{path}"}}"#);
        let _ = tokio::fs::remove_file(&self.path).await;
        if let Err(error) = mdsctl("venc", &request).await {
            self.started.store(false, Ordering::Release);
            return Err(error);
        }
        let mut jpeg = Vec::new();
        for _ in 0..20 {
            if let Ok(contents) = tokio::fs::read(&self.path).await
                && contents.len() >= 4
                && contents.starts_with(&[0xff, 0xd8])
                && contents.ends_with(&[0xff, 0xd9])
            {
                jpeg = contents;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if jpeg.is_empty() {
            self.started.store(false, Ordering::Release);
            return Err("camera returned no complete JPEG".to_string());
        }
        Ok(CameraFrame {
            width: 864,
            height: 480,
            observed_at_unix_ms: now(),
            jpeg,
        })
    }
}

pub struct CameraTelemetry {
    source: Arc<dyn CameraFrameSource>,
    frame: RwLock<Option<CameraFrame>>,
    vision: RwLock<Option<super::cat_follow::Frame>>,
    tracking: AtomicBool,
}

impl CameraTelemetry {
    pub fn new(source: Arc<dyn CameraFrameSource>) -> Arc<Self> {
        Arc::new(Self {
            source,
            frame: RwLock::new(None),
            vision: RwLock::new(None),
            tracking: AtomicBool::new(false),
        })
    }

    pub async fn current(&self) -> Option<CameraFrame> {
        self.frame.read().await.clone()
    }

    pub fn track(&self, active: bool) {
        self.tracking.store(active, Ordering::Release);
    }
    pub async fn vision(&self) -> Option<super::cat_follow::Frame> {
        self.vision.read().await.clone()
    }

    pub fn start(self: &Arc<Self>) {
        let service = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                match service.source.capture().await {
                    Ok(frame) => {
                        if service.tracking.load(Ordering::Acquire) {
                            let copy = frame.clone();
                            if let Ok(Ok(decoded)) = tokio::task::spawn_blocking(move || {
                                super::cat_follow::decode(&copy.jpeg, copy.observed_at_unix_ms)
                            })
                            .await
                            {
                                *service.vision.write().await = Some(decoded);
                            }
                        }
                        *service.frame.write().await = Some(frame);
                    }
                    Err(error) => eprintln!("camera capture retrying: {error}"),
                }
                tokio::time::sleep(Duration::from_millis(
                    if service.tracking.load(Ordering::Acquire) {
                        100
                    } else {
                        650
                    },
                ))
                .await;
            }
        });
    }
}

async fn mdsctl(component: &str, request: &str) -> Result<(), String> {
    let output = tokio::time::timeout(
        Duration::from_secs(2),
        Command::new("mdsctl")
            .arg(component)
            .arg(request)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "camera command timed out".to_string())?
    .map_err(|error| format!("cannot run mdsctl: {error}"))?;
    let response = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || response.contains("\"fail\"") {
        return Err(format!("{component} rejected camera request"));
    }
    Ok(())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default()
}

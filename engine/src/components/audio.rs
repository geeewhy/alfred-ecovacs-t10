use crate::components::clips::ClipStore;
use async_trait::async_trait;
use std::path::Path;
use std::sync::Arc;
use tokio::io::AsyncRead;
use tokio::process::Command;

#[async_trait]
pub trait AudioBackend: Send + Sync {
    async fn play(&self, path: &Path) -> Result<String, String>;
    async fn stock(&self, number: u32) -> Result<String, String>;
    async fn set_volume(&self, percent: u32) -> Result<String, String>;
}

pub struct AudioService {
    backend: Arc<dyn AudioBackend>,
    clips: Arc<dyn ClipStore>,
}

impl AudioService {
    pub fn new(backend: Arc<dyn AudioBackend>, clips: Arc<dyn ClipStore>) -> Self {
        Self { backend, clips }
    }

    pub async fn play_ogg(
        &self,
        source: &mut (dyn AsyncRead + Unpin + Send),
        length: u64,
    ) -> Result<String, String> {
        let clip = self.clips.receive_ogg(source, length).await?;
        match self.backend.play(&clip).await {
            Ok(result) => {
                self.clips.retain(clip).await;
                Ok(result)
            }
            Err(error) => {
                self.clips.discard(&clip).await;
                Err(error)
            }
        }
    }

    pub async fn stock(&self, number: u32) -> Result<String, String> {
        self.backend.stock(number).await
    }

    pub async fn set_volume(&self, percent: u32) -> Result<String, String> {
        self.backend.set_volume(percent).await
    }
}

pub struct NativeAudio;

impl NativeAudio {
    pub fn new() -> Self {
        Self
    }

    async fn output(program: &str, args: &[&str]) -> Result<(bool, String, String), String> {
        let output = Command::new(program)
            .args(args)
            .output()
            .await
            .map_err(|error| format!("cannot run {program}: {error}"))?;
        let stdout = one_line(&output.stdout);
        let stderr = one_line(&output.stderr);
        Ok((output.status.success(), stdout, stderr))
    }

    async fn run(program: &str, args: &[&str]) -> Result<String, String> {
        let (success, stdout, stderr) = Self::output(program, args).await?;
        if success {
            Ok(stdout)
        } else {
            Err(format!("{program} failed: {stdout} {stderr}"))
        }
    }
}

#[async_trait]
impl AudioBackend for NativeAudio {
    async fn play(&self, path: &Path) -> Result<String, String> {
        let path = path
            .to_str()
            .ok_or_else(|| "invalid clip path".to_string())?;
        let payload = format!(r#"{{"fileList":[{{"path":"{path}"}}],"audioType":3}}"#);
        let (_, result, _) = Self::output(
            "/usr/bin/netmon_ctl",
            &["-s", "/tmp/audio_daemon.sock", "-j", &payload],
        )
        .await?;
        if result.contains("\"ret\":\"ok\"") || result.contains("\"ret\": \"ok\"") {
            Ok(result)
        } else {
            Err(format!("audio daemon rejected playback: {result}"))
        }
    }

    async fn stock(&self, number: u32) -> Result<String, String> {
        let payload = format!(r#"{{"todo":"audio","cmd":"play","file_number":{number}}}"#);
        Self::run("/usr/bin/mdsctl", &["audio0", &payload]).await
    }

    async fn set_volume(&self, percent: u32) -> Result<String, String> {
        if percent > 100 {
            return Err("volume must be 0..100".to_string());
        }
        let payload = format!(
            r#"{{"todo":"SetVolume","sid":-1,"value":{}}}"#,
            percent * 16
        );
        Self::run("/usr/bin/mdsctl", &["audio0", &payload]).await
    }
}

fn one_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

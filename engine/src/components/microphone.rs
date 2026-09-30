//! Authenticated HTTP owns the DSP capture process and its lifetime.
use std::{process::Stdio, sync::Arc, time::Duration};
use tokio::{io::AsyncReadExt, process::{Child, ChildStdout, Command}, sync::{OwnedSemaphorePermit, Semaphore}};
use axum::body::Body;

pub struct Microphone { lease: Arc<Semaphore> }
struct Capture { child: Child, output: ChildStdout, _lease: OwnedSemaphorePermit }
impl Drop for Capture {
    fn drop(&mut self) {
        // SIGTERM runs the bridge's finally block, restoring firmware DSP ownership.
        if let Some(pid) = self.child.id() {
            let _ = std::process::Command::new("kill").args(["-TERM", &pid.to_string()]).status();
        }
    }
}
impl Microphone {
    pub fn new() -> Self { Self { lease: Arc::new(Semaphore::new(1)) } }
    pub async fn stream(&self) -> Result<Body, String> {
        let lease = self.lease.clone().try_acquire_owned().map_err(|_| "Microphone already in use".to_string())?;
        let mut child = Command::new("python")
            .args(["-u", "-c", include_str!("../../../runtime/robot_mic_server.py"), "--stdio"])
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e|e.to_string())?;
        let output = child.stdout.take().ok_or("Missing microphone pipe")?;
        let mut capture = Capture { child, output, _lease: lease };
        let mut first = vec![0;2048];
        let n = tokio::time::timeout(Duration::from_secs(10), capture.output.read(&mut first)).await
            .map_err(|_| "Microphone startup timed out")?.map_err(|e|e.to_string())?;
        if n == 0 { return Err("Microphone capture exited before audio".into()); }
        first.truncate(n);
        let stream = futures_util::stream::try_unfold((capture, Some(first)), |(mut capture, first)| async move {
            if let Some(bytes) = first { return Ok(Some((bytes, (capture, None)))); }
            let mut bytes = vec![0;4096];
            let n = tokio::time::timeout(Duration::from_secs(5), capture.output.read(&mut bytes)).await
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut,"Microphone stalled"))??;
            if n == 0 { return Ok::<_,std::io::Error>(None); }
            bytes.truncate(n);
            Ok(Some((bytes,(capture,None))))
        });
        Ok(Body::from_stream(stream))
    }
}

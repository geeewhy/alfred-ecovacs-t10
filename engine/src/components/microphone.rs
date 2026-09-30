//! Authenticated HTTP owns the DSP capture process and its lifetime.
use std::{process::Stdio, sync::Arc, time::Duration};
use tokio::{io::AsyncReadExt, process::{Child, ChildStdout, Command}, sync::{OwnedSemaphorePermit, Semaphore}};
use axum::body::Body;

pub struct Microphone { lease: Arc<Semaphore> }
struct Capture { child: Option<Child>, output: ChildStdout, lease: Option<OwnedSemaphorePermit> }
impl Drop for Capture {
    fn drop(&mut self) {
        // Keep the child owned until it exits. Firmware SDK calls can ignore TERM.
        if let Some(mut child) = self.child.take() {
            if let Some(pid) = child.id() {
                let _ = std::process::Command::new("kill").args(["-TERM", &pid.to_string()]).status();
            }
            let lease = self.lease.take();
            tokio::spawn(async move {
                let _lease = lease;
                if tokio::time::timeout(Duration::from_secs(2), child.wait()).await.is_err() {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
            });
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
        let mut capture = Capture { child: Some(child), output, lease: Some(lease) };
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stuck_capture_is_reaped_before_releasing_lease() {
        let lease = Arc::new(Semaphore::new(1));
        let permit = lease.clone().acquire_owned().await.unwrap();
        let mut child = Command::new("sh")
            .args(["-c", "trap '' TERM; printf ready; while :; do :; done"])
            .stdout(Stdio::piped()).spawn().unwrap();
        let mut output = child.stdout.take().unwrap();
        let mut ready = [0; 5];
        output.read_exact(&mut ready).await.unwrap();
        let capture = Capture { child: Some(child), output, lease: Some(permit) };
        drop(capture);
        assert!(lease.clone().try_acquire_owned().is_err());
        let _permit = tokio::time::timeout(Duration::from_secs(4), lease.acquire()).await.unwrap().unwrap();
    }
}

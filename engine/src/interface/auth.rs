use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};

pub fn load_token(path: &str) -> std::io::Result<String> {
    let token = std::fs::read_to_string(path)?.trim().to_string();
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Engine token must be 32 random bytes encoded as hex",
        ));
    }
    Ok(token)
}
fn matches(actual: &[u8], expected: &[u8]) -> bool {
    if actual.len() != expected.len() {
        return false;
    }
    actual
        .iter()
        .zip(expected)
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}
pub async fn authorize(State(token): State<String>, request: Request, next: Next) -> Response {
    let expected = format!("Bearer {token}");
    let valid = request
        .headers()
        .get("authorization")
        .map(|v| matches(v.as_bytes(), expected.as_bytes()))
        .unwrap_or(false);
    if !valid {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({"ok":false,"result":"Unauthorized"})),
        )
            .into_response();
    }
    next.run(request).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn authentication_guards_reads_and_mutations() {
        use tower::ServiceExt;
        let app = axum::Router::new()
            .route(
                "/test",
                axum::routing::get(|| async { "ok" }).post(|| async { "ok" }),
            )
            .layer(axum::middleware::from_fn_with_state(
                "a".repeat(64),
                authorize,
            ));
        for method in ["GET", "POST"] {
            for (header, status) in [
                (None, 401),
                (Some("Bearer wrong".to_string()), 401),
                (Some(format!("Bearer {}", "a".repeat(64))), 200),
            ] {
                let mut req = Request::builder().method(method).uri("/test");
                if let Some(value) = header {
                    req = req.header("Authorization", value);
                }
                let response = app
                    .clone()
                    .oneshot(req.body(axum::body::Body::empty()).unwrap())
                    .await
                    .unwrap();
                assert_eq!(response.status().as_u16(), status);
            }
        }
    }
}

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use bytes::Bytes;
use dashmap::DashMap;
use futures::{sink::SinkExt, stream::StreamExt};
use reqwest::Client;
use serde::Deserialize;
use std::{convert::Infallible, net::SocketAddr, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot};
use tower_http::cors::CorsLayer;

#[derive(Clone)]
struct AppState {
    ws_senders: Arc<DashMap<String, mpsc::Sender<String>>>,
    reply_senders: Arc<DashMap<String, oneshot::Sender<String>>>,
    auth_tokens: Arc<DashMap<String, String>>,
    http_client: Client,
}

#[derive(Deserialize)]
struct AuthMessage {
    token: String,
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    let state = AppState {
        ws_senders: Arc::new(DashMap::new()),
        reply_senders: Arc::new(DashMap::new()),
        auth_tokens: Arc::new(DashMap::new()),
        http_client: Client::new(),
    };

    let app = Router::new()
        .route("/mcp/{uuid}", post(handle_mcp).get(ws_handler))
        .route("/llm", post(handle_llm))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    let addr: SocketAddr = format!("0.0.0.0:{}", port).parse().unwrap();
    println!("Listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(uuid): Path<String>,
    State(state): State<AppState>,
) -> Response {
    if state.ws_senders.contains_key(&uuid) {
        (StatusCode::CONFLICT, "WebSocket connection already exists").into_response()
    } else {
        ws.on_upgrade(move |socket| handle_socket(socket, uuid, state))
    }
}

async fn handle_socket(socket: WebSocket, uuid: String, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::channel::<String>(100);

    state.ws_senders.insert(uuid.clone(), tx);

    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    let state_clone = state.clone();
    let uuid_clone = uuid.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            if let Message::Text(text) = msg {
                if !state_clone.auth_tokens.contains_key(&uuid_clone) {
                    if let Ok(auth_msg) = serde_json::from_str::<AuthMessage>(&text) {
                        state_clone.auth_tokens.insert(uuid_clone.clone(), auth_msg.token);
                    }
                    continue;
                }

                if let Some((_, reply_tx)) = state_clone.reply_senders.remove(&uuid_clone) {
                    let _ = reply_tx.send(text.to_string());
                }
            }
        }

        state_clone.reply_senders.remove(&uuid_clone);
    });

    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    }

    state.ws_senders.remove(&uuid);
    state.reply_senders.remove(&uuid);
    state.auth_tokens.remove(&uuid);
}

async fn handle_mcp(
    Path(uuid): Path<String>,
    headers: HeaderMap,
    State(state): State<AppState>,
    body: String,
) -> Response {
    let auth_header = headers.get("authorization").and_then(|h| h.to_str().ok());
    let is_authorized = state
        .auth_tokens
        .get(&uuid)
        .map(|expected| {
            if expected.is_empty() {
                true
            } else if let Some(h) = auth_header {
                h.len() == 7 + expected.len()
                    && h.starts_with("Bearer ")
                    && &h[7..] == expected.as_str()
            } else {
                false
            }
        })
        .unwrap_or(false);

    if !is_authorized {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }

    let (tx, rx) = oneshot::channel();
    state.reply_senders.insert(uuid.clone(), tx);

    if let Some(ws_tx) = state.ws_senders.get(&uuid) {
        if ws_tx.send(body).await.is_err() {
            state.reply_senders.remove(&uuid);
            return (StatusCode::INTERNAL_SERVER_ERROR, "WebSocket disconnected").into_response();
        }
    } else {
        state.reply_senders.remove(&uuid);
        return (StatusCode::NOT_FOUND, "WebSocket not connected").into_response();
    }

    match tokio::time::timeout(Duration::from_secs(240), rx).await {
        Ok(Ok(reply)) => {
            if reply.len() >= 3 {
                let status_str = &reply[0..3];
                let content = &reply[3..];
                if let Ok(status_code) = status_str.parse::<u16>() {
                    if let Ok(status) = StatusCode::from_u16(status_code) {
                        return (
                            status,
                            [("Content-Type", "application/json")],
                            content.to_string(),
                        )
                            .into_response();
                    }
                }
            }
            (StatusCode::INTERNAL_SERVER_ERROR, "Invalid reply format").into_response()
        }
        Ok(Err(_)) => (StatusCode::INTERNAL_SERVER_ERROR, "Reply channel closed").into_response(),
        Err(_) => {
            state.reply_senders.remove(&uuid);
            (StatusCode::GATEWAY_TIMEOUT, "Timed out waiting for WebSocket reply").into_response()
        }
    }
}

fn is_allowed_host(hostname: &str) -> bool {
    hostname == "localhost"
        || hostname == "127.0.0.1"
        || hostname.starts_with("192.168.")
        || hostname.starts_with("10.")
        || hostname
            .strip_prefix("172.")
            .and_then(|rest| rest.split('.').next())
            .and_then(|seg| seg.parse::<u8>().ok())
            .map(|n| (16..=31).contains(&n))
            .unwrap_or(false)
}

fn origin_allowed(headers: &HeaderMap) -> bool {
    headers
        .get("origin")
        .or_else(|| headers.get("referer"))
        .and_then(|val| val.to_str().ok())
        .and_then(|s| url::Url::parse(s).ok())
        .and_then(|url| url.host_str().map(is_allowed_host))
        .unwrap_or(false)
}

async fn handle_llm(
    headers: HeaderMap,
    State(state): State<AppState>,
    body: Bytes,
) -> Response {
    if !origin_allowed(&headers) {
        return (
            StatusCode::FORBIDDEN,
            r#"{"error":"Only use this endpoint for development"}"#,
        )
            .into_response();
    }

    let api_key = match headers.get("x-api-key") {
        Some(val) => match val.to_str() {
            Ok(s) if !s.is_empty() => s.to_string(),
            _ => String::new(),
        },
        None => String::new(),
    };

    if api_key.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            r#"{"error":"Missing API key"}"#,
        )
            .into_response();
    }

    let req = state
        .http_client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "mcp-client-2025-11-20")
        .header("content-type", "application/json")
        .body(body);

    let res = match req.send().await {
        Ok(res) => res,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to call Anthropic API: {}", e),
            )
                .into_response();
        }
    };

    let status = res.status();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let stream = res.bytes_stream().map(|result| match result {
        Ok(bytes) => Ok::<_, Infallible>(bytes),
        Err(e) => Ok::<_, Infallible>(Bytes::from(format!("stream error: {}", e))),
    });

    let body = axum::body::Body::from_stream(stream);
    let mut response = Response::new(body);
    *response.status_mut() = status;
    response.headers_mut().insert(
        "Content-Type",
        content_type.parse().unwrap(),
    );
    response.headers_mut().insert(
        "Cache-Control",
        "no-cache".parse().unwrap(),
    );

    response
}

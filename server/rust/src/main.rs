use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::{HeaderMap, StatusCode},
    response::{sse::{Event, Sse}, IntoResponse, Response},
    routing::{get, post},
    Router,
};
use bytes::Bytes;
use dashmap::DashMap;
use futures::{sink::SinkExt, stream::StreamExt};
use reqwest::Client;
use serde::Deserialize;
use std::{convert::Infallible, net::SocketAddr, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::ReceiverStream;
use tower_http::cors::CorsLayer;

#[derive(Clone)]
struct AppState {
    sessions: Arc<DashMap<String, Session>>,
    http_client: Client,
}

#[derive(Clone)]
struct Session {
    auth_token: String,
    ws_tx: mpsc::Sender<String>,
    pending: Arc<DashMap<String, PendingRequest>>,
    sse_txs: Arc<DashMap<usize, mpsc::Sender<Event>>>,
    sse_counter: Arc<std::sync::atomic::AtomicUsize>,
    seq: Arc<std::sync::atomic::AtomicU16>,
}

// A pending HTTP request waiting for a WS response.
// Either a single response (oneshot) or a streaming SSE response.
enum PendingRequest {
    Single(oneshot::Sender<(u16, String)>),
    Streaming(mpsc::Sender<StreamEvent>),
}

enum StreamEvent {
    Chunk(String),
    End(u16, String),
}

#[derive(Deserialize)]
struct AuthMessage {
    token: String,
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    let state = AppState {
        sessions: Arc::new(DashMap::new()),
        http_client: Client::new(),
    };

    let app = Router::new()
        .route("/mcp/{uuid}", post(handle_mcp_post).get(sse_handler).delete(handle_mcp_delete))
        .route("/mcp/ws/{uuid}", get(ws_handler))
        .route("/llm", post(handle_llm))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    let addr: SocketAddr = format!("0.0.0.0:{}", port).parse().unwrap();
    println!("Listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

// Guard that removes the SSE sender from the map when dropped,
// even if the stream future is abandoned by Axum (client disconnect).
struct SseGuard {
    sse_txs: Arc<DashMap<usize, mpsc::Sender<Event>>>,
    stream_id: usize,
}

impl Drop for SseGuard {
    fn drop(&mut self) {
        self.sse_txs.remove(&self.stream_id);
    }
}

fn next_request_id(seq: &std::sync::atomic::AtomicU16) -> String {
    let n = seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed) & 0xfff;
    format!("{:03x}", n)
}

// Finds a free request-id slot, trying up to 4096 candidates.
// Returns None if all slots are occupied (extremely unlikely).
fn alloc_request_id(
    seq: &std::sync::atomic::AtomicU16,
    pending: &DashMap<String, PendingRequest>,
) -> Option<String> {
    for _ in 0..=0xfff {
        let id = next_request_id(seq);
        if !pending.contains_key(&id) {
            return Some(id);
        }
    }
    None
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(uuid): Path<String>,
    State(state): State<AppState>,
) -> Response {
    if state.sessions.contains_key(&uuid) {
        return (StatusCode::CONFLICT, "WebSocket connection already exists").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, uuid, state))
}

async fn handle_socket(socket: WebSocket, uuid: String, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let (ws_tx, mut ws_rx) = mpsc::channel::<String>(100);

    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = ws_rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    let state_clone = state.clone();
    let uuid_clone = uuid.clone();
    let mut recv_task = tokio::spawn(async move {
        // Local flag avoids the TOCTOU race on `sessions.contains_key`.
        let mut authenticated = false;

        while let Some(Ok(msg)) = receiver.next().await {
            if let Message::Text(text) = msg {
                if !authenticated {
                    // First message must be auth
                    if let Ok(auth_msg) = serde_json::from_str::<AuthMessage>(&text) {
                        let session = Session {
                            auth_token: auth_msg.token,
                            ws_tx: ws_tx.clone(),
                            pending: Arc::new(DashMap::new()),
                            sse_txs: Arc::new(DashMap::new()),
                            sse_counter: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                            seq: Arc::new(std::sync::atomic::AtomicU16::new(0)),
                        };
                        state_clone.sessions.insert(uuid_clone.clone(), session);
                        authenticated = true;
                    } else {
                        // Invalid auth payload — close
                        break;
                    }
                    continue;
                }

                // message format: requestId(3) + statusCode(3) + content
                // statusCode "CHK" = streaming chunk, keep SSE open
                // statusCode = 3-digit number = final response (or empty for notifications)
                if text.len() >= 6 {
                    let request_id = &text[0..3];
                    let status_str = &text[3..6];
                    let content = text[6..].to_string();

                    if let Some(session) = state_clone.sessions.get(&uuid_clone) {
                        if status_str == "CHK" {
                            // Streaming chunk — forward to SSE sender without removing pending
                            if let Some(pending) = session.pending.get(request_id) {
                                if let PendingRequest::Streaming(ref tx) = *pending {
                                    let _ = tx.send(StreamEvent::Chunk(content)).await;
                                }
                            }
                        } else if let Ok(status_code) = status_str.parse::<u16>() {
                            if let Some((_, pending)) = session.pending.remove(request_id) {
                                match pending {
                                    PendingRequest::Single(tx) => {
                                        let _ = tx.send((status_code, content));
                                    }
                                    PendingRequest::Streaming(tx) => {
                                        let _ = tx.send(StreamEvent::End(status_code, content)).await;
                                    }
                                }
                            }
                        } else {
                            // Unrecognised status token — unblock the caller with a 502
                            // so it doesn't hang until the 240 s timeout.
                            eprintln!(
                                "[ws {}] unrecognised status {:?} for request {}; unblocking caller",
                                uuid_clone, status_str, request_id
                            );
                            if let Some((_, pending)) = session.pending.remove(request_id) {
                                match pending {
                                    PendingRequest::Single(tx) => {
                                        let _ = tx.send((502, "bad gateway: unrecognised WS status token".into()));
                                    }
                                    PendingRequest::Streaming(tx) => {
                                        let _ = tx.send(StreamEvent::End(502, "bad gateway: unrecognised WS status token".into())).await;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    });

    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    }

    // Clean up session and close SSE streams
    if let Some((_, session)) = state.sessions.remove(&uuid) {
        for entry in session.sse_txs.iter() {
            drop(entry); // dropping sender closes the SSE stream
        }
        session.sse_txs.clear();
    }
}

async fn sse_handler(
    Path(uuid): Path<String>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    let session = match state.sessions.get(&uuid) {
        Some(s) => s.clone(),
        None => return (StatusCode::NOT_FOUND, "No active session").into_response(),
    };

    let auth_header = headers.get("authorization").and_then(|h| h.to_str().ok());
    let authorized = session.auth_token.is_empty()
        || auth_header
            .map(|h| h.strip_prefix("Bearer ").map(|t| t == session.auth_token).unwrap_or(false))
            .unwrap_or(false);
    if !authorized {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }

    let (tx, rx) = mpsc::channel::<Event>(100);
    let stream_id = session.sse_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    session.sse_txs.insert(stream_id, tx.clone());

    // Guard ensures the sender slot is freed even on abrupt client disconnect.
    let guard = SseGuard {
        sse_txs: session.sse_txs.clone(),
        stream_id,
    };

    // Send initial keep-alive event with an event ID
    let event_id = format!("{}-{}", uuid, stream_id);
    let _ = tx.send(Event::default().id(event_id).comment("keep-alive")).await;

    let stream = async_stream::stream! {
        // Owns the guard; dropped when the stream is dropped.
        let _guard = guard;
        let mut stream = ReceiverStream::new(rx);
        while let Some(event) = stream.next().await {
            yield Ok::<Event, Infallible>(event);
        }
    };

    let mut response = Sse::new(stream)
        .keep_alive(axum::response::sse::KeepAlive::new())
        .into_response();
    response.headers_mut().insert("Mcp-Session-Id", uuid.parse().unwrap());
    response
}

async fn handle_mcp_delete(
    Path(uuid): Path<String>,
    State(state): State<AppState>,
) -> Response {
    match state.sessions.remove(&uuid) {
        Some((_, session)) => {
            for entry in session.sse_txs.iter() {
                drop(entry);
            }
            session.sse_txs.clear();
            (StatusCode::OK, "").into_response()
        }
        None => (StatusCode::NOT_FOUND, "No active session").into_response(),
    }
}

async fn handle_mcp_post(
    Path(uuid): Path<String>,
    headers: HeaderMap,
    State(state): State<AppState>,
    body: String,
) -> Response {
    let session = match state.sessions.get(&uuid) {
        Some(s) => s.clone(),
        None => return (StatusCode::NOT_FOUND, "No active session").into_response(),
    };

    let auth_header = headers.get("authorization").and_then(|h| h.to_str().ok());
    let authorized = session.auth_token.is_empty()
        || auth_header
            .map(|h| h.strip_prefix("Bearer ").map(|t| t == session.auth_token).unwrap_or(false))
            .unwrap_or(false);
    if !authorized {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }

    let wants_sse = headers
        .get("accept")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("text/event-stream"))
        .unwrap_or(false);

    let request_id = match alloc_request_id(&session.seq, &session.pending) {
        Some(id) => id,
        None => return (StatusCode::TOO_MANY_REQUESTS, "Too many concurrent requests").into_response(),
    };

    if wants_sse {
        let (stream_tx, mut stream_rx) = mpsc::channel::<StreamEvent>(32);
        session.pending.insert(request_id.clone(), PendingRequest::Streaming(stream_tx));

        let mut msg = String::with_capacity(request_id.len() + body.len());
        msg.push_str(&request_id);
        msg.push_str(&body);
        if session.ws_tx.send(msg).await.is_err() {
            session.pending.remove(&request_id);
            return (StatusCode::INTERNAL_SERVER_ERROR, "WebSocket disconnected").into_response();
        }

        let sse_stream = async_stream::stream! {
            let mut event_seq: u32 = 0;
            loop {
                match tokio::time::timeout(Duration::from_secs(240), stream_rx.recv()).await {
                    Ok(Some(StreamEvent::Chunk(content))) => {
                        let event_id = format!("{}-{}", request_id, event_seq);
                        event_seq += 1;
                        yield Ok::<Event, Infallible>(
                            Event::default().id(event_id).data(content)
                        );
                    }
                    Ok(Some(StreamEvent::End(_status, content))) => {
                        let event_id = format!("{}-{}", request_id, event_seq);
                        yield Ok::<Event, Infallible>(
                            Event::default().id(event_id).data(content)
                        );
                        break;
                    }
                    Ok(None) | Err(_) => {
                        // Channel closed or timeout — end stream
                        break;
                    }
                }
            }
        };

        let mut response = Sse::new(sse_stream)
            .keep_alive(axum::response::sse::KeepAlive::new())
            .into_response();
        response.headers_mut().insert("Mcp-Session-Id", uuid.parse().unwrap());
        response
    } else {
        let (tx, rx) = oneshot::channel();
        session.pending.insert(request_id.clone(), PendingRequest::Single(tx));

        let mut msg = String::with_capacity(request_id.len() + body.len());
        msg.push_str(&request_id);
        msg.push_str(&body);
        if session.ws_tx.send(msg).await.is_err() {
            session.pending.remove(&request_id);
            return (StatusCode::INTERNAL_SERVER_ERROR, "WebSocket disconnected").into_response();
        }

        match tokio::time::timeout(Duration::from_secs(240), rx).await {
            Ok(Ok((status_code, content))) => {
                let status = StatusCode::from_u16(status_code).unwrap_or(StatusCode::OK);
                match Response::builder()
                    .status(status)
                    .header("Content-Type", "application/json")
                    .header("Mcp-Session-Id", uuid.as_str())
                    .body(axum::body::Body::from(content))
                {
                    Ok(response) => response,
                    Err(e) => {
                        eprintln!("Failed to build response: {}", e);
                        (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build response").into_response()
                    }
                }
            }
            Ok(Err(_)) => (StatusCode::INTERNAL_SERVER_ERROR, "Reply channel closed").into_response(),
            Err(_) => {
                session.pending.remove(&request_id);
                (StatusCode::GATEWAY_TIMEOUT, "Timed out waiting for WebSocket reply").into_response()
            }
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
        .cloned();

    let stream = res.bytes_stream().map(|result| match result {
        Ok(bytes) => Ok::<_, Infallible>(bytes),
        Err(e) => Ok::<_, Infallible>(Bytes::from(format!("stream error: {}", e))),
    });

    let body = axum::body::Body::from_stream(stream);
    let mut response = Response::new(body);
    *response.status_mut() = status;

    if let Some(ct) = content_type {
        response.headers_mut().insert("Content-Type", ct);
    }
    response.headers_mut().insert(
        "Cache-Control",
        "no-cache".parse().unwrap(),
    );

    response
}

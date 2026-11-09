use relaycast::{AgentClient, ClientOptions, HttpClient, RelayCast};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;
use std::time::Duration;

fn reply(
    listener: TcpListener,
    count: usize,
    marker: &'static str,
) -> thread::JoinHandle<Vec<String>> {
    thread::spawn(move || {
        (0..count).map(|_| {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = [0;8192]; let read = stream.read(&mut bytes).unwrap();
            let request = String::from_utf8_lossy(&bytes[..read]).to_lowercase();
            let body = json!({"ok":true,"data":{"marker":marker}}).to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            request
        }).collect()
    })
}

#[tokio::test]
async fn key_replacement_and_typed_clients_keep_injected_transport_and_metadata() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = reply(listener, 3, "injected");
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("x-selected-transport", "retained".parse().unwrap());
    let transport = reqwest::Client::builder()
        .default_headers(headers)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let http = HttpClient::with_http_client(
        ClientOptions::new("test-workspace")
            .with_base_url(origin)
            .with_origin("test-product", "1"),
        transport,
    );
    http.get::<Value>("/one", None, None).await.unwrap();
    let replacement = http.with_api_key("test-agent").unwrap();
    AgentClient::from_client(replacement.clone())
        .http_client()
        .get::<Value>("/two", None, None)
        .await
        .unwrap();
    RelayCast::from_client(replacement)
        .unwrap()
        .as_agent("test-agent")
        .unwrap()
        .http_client()
        .get::<Value>("/three", None, None)
        .await
        .unwrap();
    let requests = server.join().unwrap();
    assert!(requests
        .iter()
        .all(|r| r.contains("x-selected-transport: retained")
            && r.contains("x-relaycast-origin-client: test-product")));
    assert!(requests[0].contains("authorization: bearer test-workspace"));
    assert!(requests[1..]
        .iter()
        .all(|r| r.contains("authorization: bearer test-agent")));
}

#[tokio::test]
async fn key_replacement_never_reenables_redirects() {
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    target.set_nonblocking(true).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let location = format!(
        "http://{}/must-not-receive-credentials",
        target.local_addr().unwrap()
    );
    let server = thread::spawn(move || {
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = [0; 4096];
            stream.read(&mut bytes).unwrap();
            let body = json!({"ok":true,"data":null}).to_string();
            write!(stream,"HTTP/1.1 302 Found\r\nLocation: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",location,body.len(),body).unwrap();
        }
    });
    let transport = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let client = HttpClient::with_http_client(
        ClientOptions::new("test-key").with_base_url(origin),
        transport,
    );
    client.get::<Value>("/one", None, None).await.unwrap();
    client
        .with_api_key("next-test-key")
        .unwrap()
        .get::<Value>("/two", None, None)
        .await
        .unwrap();
    server.join().unwrap();
    assert_eq!(
        target.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn workspace_wrapper_keeps_empty_key_refusal() {
    let transport = reqwest::Client::new();
    let client = HttpClient::with_http_client(ClientOptions::new(" "), transport);
    assert!(RelayCast::from_client(client).is_err());
}

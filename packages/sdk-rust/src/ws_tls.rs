//! The TLS client configuration every `wss://` connect shares.
//!
//! Trust comes from the platform's root certificates. Reading them walks the
//! keychain and evaluates each certificate's trust settings on macOS, so they
//! are read once per process and the configuration is handed to every connect
//! and reconnect, instead of tokio-tungstenite reading them again on each one.

use std::io;
use std::sync::Arc;

use rustls::{ClientConfig, RootCertStore};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::{handshake::client::Response, Error};
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};
use tracing::warn;
use url::Url;

pub(crate) type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

static SHARED: SharedConfig = SharedConfig::new();

/// Opens a WebSocket; `wss://` uses the shared TLS configuration.
pub(crate) async fn connect(url: &Url) -> Result<(WsStream, Response), Box<Error>> {
    connect_with(&SHARED, native_roots, url).await
}

async fn connect_with(
    shared: &SharedConfig,
    roots: impl FnOnce() -> RootCertStore + Send + 'static,
    url: &Url,
) -> Result<(WsStream, Response), Box<Error>> {
    let connector = if url.scheme() == "wss" {
        let config = shared.config(roots).await.map_err(Error::Io)?;
        Some(Connector::Rustls(config))
    } else {
        None
    };
    Ok(
        tokio_tungstenite::connect_async_tls_with_config(url.as_str(), None, false, connector)
            .await?,
    )
}

fn native_roots() -> RootCertStore {
    let native = rustls_native_certs::load_native_certs();
    if !native.errors.is_empty() {
        warn!(errors = ?native.errors, "native root CA certificate loading errors");
    }
    let mut roots = RootCertStore::empty();
    roots.add_parsable_certificates(native.certs);
    roots
}

/// One configuration, built by the first connect while concurrent ones wait
/// for it. A platform that offers no roots fails that connect and is asked
/// again on the next one. Roots are read on the blocking pool, off the
/// runtime's workers.
struct SharedConfig(Mutex<Option<Arc<ClientConfig>>>);

impl SharedConfig {
    const fn new() -> Self {
        Self(Mutex::const_new(None))
    }

    async fn config(
        &self,
        roots: impl FnOnce() -> RootCertStore + Send + 'static,
    ) -> io::Result<Arc<ClientConfig>> {
        let mut shared = self.0.lock().await;
        if let Some(config) = &*shared {
            return Ok(config.clone());
        }
        let roots = tokio::task::spawn_blocking(roots).await?;
        if roots.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "no native root CA certificates found",
            ));
        }
        let config = Arc::new(
            ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        );
        *shared = Some(config.clone());
        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::pki_types::{Der, TrustAnchor};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn counted(
        loads: &Arc<AtomicUsize>,
        roots: fn() -> RootCertStore,
    ) -> impl FnOnce() -> RootCertStore + Send + 'static {
        let loads = loads.clone();
        move || {
            loads.fetch_add(1, Ordering::SeqCst);
            roots()
        }
    }

    fn one_root() -> RootCertStore {
        RootCertStore {
            roots: vec![TrustAnchor {
                subject: Der::from_slice(b"subject"),
                subject_public_key_info: Der::from_slice(b"spki"),
                name_constraints: None,
            }],
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_first_connects_read_the_roots_once() {
        let shared = Arc::new(SharedConfig::new());
        let loads = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(tokio::sync::Barrier::new(8));
        let connects: Vec<_> = (0..8)
            .map(|_| {
                let (shared, loads, start) = (shared.clone(), loads.clone(), start.clone());
                tokio::spawn(async move {
                    start.wait().await;
                    shared
                        .config(move || {
                            loads.fetch_add(1, Ordering::SeqCst);
                            std::thread::sleep(std::time::Duration::from_millis(20));
                            one_root()
                        })
                        .await
                        .unwrap()
                })
            })
            .collect();
        let mut configs = Vec::new();
        for connect in connects {
            configs.push(connect.await.unwrap());
        }
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        assert!(configs
            .iter()
            .all(|config| Arc::ptr_eq(config, &configs[0])));
    }

    #[tokio::test]
    async fn no_roots_fail_the_connect_and_are_asked_for_again() {
        let shared = SharedConfig::new();
        let loads = Arc::new(AtomicUsize::new(0));
        let error = shared
            .config(counted(&loads, RootCertStore::empty))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        let first = shared.config(counted(&loads, one_root)).await.unwrap();
        let second = shared.config(counted(&loads, one_root)).await.unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(loads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn reconnects_reuse_the_first_connects_configuration() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("wss://{}/", listener.local_addr().unwrap())).unwrap();
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                drop(socket);
            }
        });

        let shared = SharedConfig::new();
        let loads = Arc::new(AtomicUsize::new(0));
        let _ = connect_with(&shared, counted(&loads, one_root), &url).await;
        let first = shared
            .0
            .lock()
            .await
            .clone()
            .expect("a cached configuration");
        let _ = connect_with(&shared, counted(&loads, one_root), &url).await;
        let second = shared
            .0
            .lock()
            .await
            .clone()
            .expect("a cached configuration");
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(loads.load(Ordering::SeqCst), 1);
    }
}

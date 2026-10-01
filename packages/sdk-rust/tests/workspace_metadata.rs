use relaycast::{
    RelayCast, RelayCastOptions, UpdateWorkspaceRequest, Workspace, WorkspaceBootstrapOptions,
    WorkspaceProvenance,
};
use serde_json::json;
use wiremock::matchers::{body_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn workspace_metadata_create_update_and_read() {
    let server = MockServer::start().await;
    let metadata = json!({"camelKey": {"nested_key": [true, 42, null]}, "empty": ""});
    Mock::given(method("POST"))
        .and(path("/v1/workspaces"))
        .and(body_json(json!({"name": "metadata", "provenance": {"source": "sdk"}, "metadata": metadata})))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({"ok": true, "data": {"workspace_id": "ws_1", "api_key": "rk_test", "created_at": "now"}})))
        .expect(1).mount(&server).await;
    RelayCast::create_workspace_with_options(
        "metadata",
        WorkspaceBootstrapOptions::new(WorkspaceProvenance::sdk())
            .with_base_url(server.uri())
            .with_metadata(metadata.as_object().unwrap().clone()),
    )
    .await
    .unwrap();

    // Exact public shape returned by engine getWorkspace for both GET and PATCH:
    // api_key_hash is private and deliberately omitted.
    let merged_metadata = json!({"camelKey": {"replacement": false}, "empty": ""});
    let workspace = json!({
        "id": "ws_1",
        "name": "metadata",
        "plan": "free",
        "system_prompt": null,
        "created_at": "2026-10-01T00:00:00.000Z",
        "metadata": merged_metadata,
        "effective_retention": {"messages": {
            "policy": "unknown", "message_ttl_days": null, "retained_since": null,
            "source": "unknown", "reason": "boundary_unavailable"
        }},
        "expires_at": null,
        "provenance": null,
        "usage_classification": "unknown",
        "classification_source": "unclassified",
        "classification_reason": null,
        "classified_at": null
    });
    let patch = json!({"remove": null, "camelKey": {"replacement": false}});
    Mock::given(method("PATCH"))
        .and(path("/v1/workspace"))
        .and(body_json(json!({"metadata": patch})))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"ok": true, "data": workspace})),
        )
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/workspace"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"ok": true, "data": workspace})),
        )
        .expect(1)
        .mount(&server)
        .await;
    let relay =
        RelayCast::new(RelayCastOptions::new("rk_test").with_base_url(server.uri())).unwrap();
    let updated = relay
        .update_workspace(UpdateWorkspaceRequest {
            metadata: Some(patch.as_object().unwrap().clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(json!(updated.metadata), merged_metadata);
    assert!(updated.api_key_hash.is_empty());
    let loaded = relay.workspace_info().await.unwrap();
    assert_eq!(json!(loaded.metadata), merged_metadata);
    assert!(loaded.api_key_hash.is_empty());
}

#[test]
fn workspace_without_metadata_defaults_to_empty_object() {
    let workspace: Workspace = serde_json::from_value(json!({"id": "ws_1", "name": "legacy", "system_prompt": null, "plan": "free", "created_at": "now"})).unwrap();
    assert!(workspace.metadata.is_empty());
    assert!(workspace.api_key_hash.is_empty());
    assert_eq!(
        serde_json::to_value(UpdateWorkspaceRequest::default()).unwrap(),
        json!({})
    );
}

#[test]
fn workspace_preserves_legacy_api_key_hash_when_present() {
    let workspace: Workspace = serde_json::from_value(json!({
        "id": "ws_1", "name": "legacy", "api_key_hash": "legacy-hash",
        "system_prompt": null, "plan": "free", "created_at": "now", "metadata": {}
    }))
    .unwrap();
    assert_eq!(workspace.api_key_hash, "legacy-hash");
}

#[test]
fn workspace_bootstrap_debug_redacts_metadata_and_preserves_presence() {
    let options = WorkspaceBootstrapOptions::new(WorkspaceProvenance::sdk());
    assert!(format!("{options:?}").contains("metadata: None"));

    let metadata = json!({
        "private_label": "sensitive-description",
        "nested": {"values": ["sensitive-nested-value", 42]}
    });
    let options = options.with_metadata(metadata.as_object().unwrap().clone());
    let debug = format!("{options:?}");
    assert!(debug.contains("metadata: Some(\"<redacted>\")"));
    for value in [
        "private_label",
        "sensitive-description",
        "nested",
        "sensitive-nested-value",
        "42",
    ] {
        assert!(
            !debug.contains(value),
            "metadata leaked in Debug output: {value}"
        );
    }

    let empty_options = WorkspaceBootstrapOptions::new(WorkspaceProvenance::sdk())
        .with_metadata(serde_json::Map::new());
    assert!(format!("{empty_options:?}").contains("metadata: Some(\"<redacted>\")"));
}

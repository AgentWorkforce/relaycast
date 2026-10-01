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

    let workspace = json!({"id": "ws_1", "name": "metadata", "api_key_hash": "hash", "system_prompt": null, "plan": "free", "created_at": "now", "metadata": metadata});
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
    assert_eq!(json!(updated.metadata), metadata);
    assert_eq!(
        json!(relay.workspace_info().await.unwrap().metadata),
        metadata
    );
}

#[test]
fn workspace_without_metadata_defaults_to_empty_object() {
    let workspace: Workspace = serde_json::from_value(json!({"id": "ws_1", "name": "legacy", "api_key_hash": "hash", "system_prompt": null, "plan": "free", "created_at": "now"})).unwrap();
    assert!(workspace.metadata.is_empty());
    assert_eq!(
        serde_json::to_value(UpdateWorkspaceRequest::default()).unwrap(),
        json!({})
    );
}

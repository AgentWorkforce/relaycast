use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::agent::AgentClient;
use crate::error::{RelayError, Result};
use crate::types::{
    MessageWithMeta, MultiWorkspaceMembershipStatus, MultiWorkspaceStatus,
    WorkspaceMembershipConfig, WorkspaceRef, WorkspaceScopedEvent, WorkspaceSendTarget, WsEvent,
};
use crate::ws::WsLifecycleEvent;

struct WorkspaceMembership {
    config: WorkspaceMembershipConfig,
    agent: AgentClient,
    subscribed_channels: HashSet<String>,
    connected: Arc<AtomicBool>,
    event_task: Option<JoinHandle<()>>,
    lifecycle_task: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct WorkspaceScope {
    workspace_id: String,
    workspace_alias: Option<String>,
    agent_id: Option<String>,
    agent_name: Option<String>,
}

impl WorkspaceScope {
    fn from_config(config: &WorkspaceMembershipConfig) -> Self {
        Self {
            workspace_id: config.workspace_id.clone(),
            workspace_alias: config.workspace_alias.clone(),
            agent_id: config.agent_id.clone(),
            agent_name: config.agent_name.clone(),
        }
    }

    fn scope_event<T>(&self, event: T) -> WorkspaceScopedEvent<T> {
        WorkspaceScopedEvent {
            workspace_id: self.workspace_id.clone(),
            workspace_alias: self.workspace_alias.clone(),
            agent_id: self.agent_id.clone(),
            agent_name: self.agent_name.clone(),
            event,
        }
    }
}

pub struct MultiWorkspaceSessionManager {
    default_workspace_id: Option<String>,
    workspace_order: Vec<String>,
    memberships: HashMap<String, WorkspaceMembership>,
    event_tx: broadcast::Sender<WorkspaceScopedEvent<WsEvent>>,
    lifecycle_tx: broadcast::Sender<WorkspaceScopedEvent<WsLifecycleEvent>>,
}

impl MultiWorkspaceSessionManager {
    pub fn new(
        memberships: Vec<WorkspaceMembershipConfig>,
        default_workspace_id: Option<String>,
    ) -> Result<Self> {
        if memberships.is_empty() {
            return Err(RelayError::InvalidResponse(
                "At least one workspace membership is required.".to_string(),
            ));
        }

        let (event_tx, _) = broadcast::channel(1024);
        let (lifecycle_tx, _) = broadcast::channel(256);
        let mut workspace_order = Vec::with_capacity(memberships.len());
        let mut membership_map = HashMap::with_capacity(memberships.len());
        let mut aliases = HashSet::new();

        for mut membership in memberships {
            membership.workspace_id = membership.workspace_id.trim().to_string();
            membership.agent_token = membership.agent_token.trim().to_string();
            membership.base_url = membership
                .base_url
                .take()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            membership.workspace_alias = membership
                .workspace_alias
                .take()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            membership.agent_id = membership
                .agent_id
                .take()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            membership.agent_name = membership
                .agent_name
                .take()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            membership.channels = normalize_channels(membership.channels);

            if membership.workspace_id.is_empty() {
                return Err(RelayError::InvalidResponse(
                    "workspace_id is required for each membership.".to_string(),
                ));
            }
            if membership.agent_token.is_empty() {
                return Err(RelayError::InvalidResponse(format!(
                    "agent_token is required for workspace {}.",
                    membership.workspace_id
                )));
            }
            if membership_map.contains_key(&membership.workspace_id) {
                return Err(RelayError::InvalidResponse(format!(
                    "Duplicate workspace_id \"{}\" is not allowed.",
                    membership.workspace_id
                )));
            }
            if let Some(alias) = membership.workspace_alias.as_ref() {
                if !aliases.insert(alias.clone()) {
                    return Err(RelayError::InvalidResponse(format!(
                        "Duplicate workspace_alias \"{}\" is not allowed.",
                        alias
                    )));
                }
            }

            let agent =
                AgentClient::new(membership.agent_token.clone(), membership.base_url.clone())?;
            workspace_order.push(membership.workspace_id.clone());
            membership_map.insert(
                membership.workspace_id.clone(),
                WorkspaceMembership {
                    subscribed_channels: membership.channels.iter().cloned().collect(),
                    config: membership,
                    agent,
                    connected: Arc::new(AtomicBool::new(false)),
                    event_task: None,
                    lifecycle_task: None,
                },
            );
        }

        let default_workspace_id = default_workspace_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if let Some(default_workspace_id) = default_workspace_id.as_ref() {
            if !membership_map.contains_key(default_workspace_id) {
                return Err(RelayError::InvalidResponse(format!(
                    "default_workspace_id \"{}\" is not configured.",
                    default_workspace_id
                )));
            }
        }

        Ok(Self {
            default_workspace_id,
            workspace_order,
            memberships: membership_map,
            event_tx,
            lifecycle_tx,
        })
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<WorkspaceScopedEvent<WsEvent>> {
        self.event_tx.subscribe()
    }

    pub fn subscribe_lifecycle(
        &self,
    ) -> broadcast::Receiver<WorkspaceScopedEvent<WsLifecycleEvent>> {
        self.lifecycle_tx.subscribe()
    }

    pub fn status(&self) -> MultiWorkspaceStatus {
        let memberships = self
            .workspace_order
            .iter()
            .filter_map(|workspace_id| self.memberships.get(workspace_id))
            .map(|membership| {
                let mut channels = membership
                    .subscribed_channels
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>();
                channels.sort();

                MultiWorkspaceMembershipStatus {
                    workspace_id: membership.config.workspace_id.clone(),
                    workspace_alias: membership.config.workspace_alias.clone(),
                    agent_id: membership.config.agent_id.clone(),
                    agent_name: membership.config.agent_name.clone(),
                    connected: membership.connected.load(Ordering::SeqCst),
                    channels,
                }
            })
            .collect();

        MultiWorkspaceStatus {
            default_workspace_id: self.default_workspace_id.clone(),
            memberships,
        }
    }

    pub async fn connect_all(&mut self) -> Result<()> {
        let workspace_ids = self.workspace_order.clone();
        for workspace_id in workspace_ids {
            let subscribed_channels = {
                let membership = self.memberships.get_mut(&workspace_id).unwrap();
                membership.agent.ensure_ws();
                membership
                    .subscribed_channels
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
            };

            self.start_forwarders(&workspace_id)?;

            {
                let membership = self.memberships.get_mut(&workspace_id).unwrap();
                membership.agent.connect().await?;
                membership.connected.store(true, Ordering::SeqCst);
            }

            if !subscribed_channels.is_empty() {
                self.memberships
                    .get(&workspace_id)
                    .unwrap()
                    .agent
                    .subscribe_channels(subscribed_channels)
                    .await?;
            }
        }
        Ok(())
    }

    pub async fn disconnect_all(&mut self) {
        let workspace_ids = self.workspace_order.clone();
        for workspace_id in workspace_ids {
            if let Some(membership) = self.memberships.get_mut(&workspace_id) {
                membership.connected.store(false, Ordering::SeqCst);
                membership.agent.disconnect().await;
                if let Some(task) = membership.event_task.take() {
                    task.abort();
                }
                if let Some(task) = membership.lifecycle_task.take() {
                    task.abort();
                }
            }
        }
    }

    pub async fn subscribe(
        &mut self,
        workspace: WorkspaceRef,
        channels: Vec<String>,
    ) -> Result<()> {
        let workspace_id = self.resolve_workspace_id(Some(&workspace))?.to_string();
        let membership = self.memberships.get_mut(&workspace_id).unwrap();
        let channels = normalize_channels(channels);
        if channels.is_empty() {
            return Ok(());
        }

        for channel in &channels {
            membership.subscribed_channels.insert(channel.clone());
        }
        membership.agent.subscribe_channels(channels).await
    }

    pub async fn unsubscribe(
        &mut self,
        workspace: WorkspaceRef,
        channels: Vec<String>,
    ) -> Result<()> {
        let workspace_id = self.resolve_workspace_id(Some(&workspace))?.to_string();
        let membership = self.memberships.get_mut(&workspace_id).unwrap();
        let channels = normalize_channels(channels)
            .into_iter()
            .filter(|channel| membership.subscribed_channels.contains(channel))
            .collect::<Vec<_>>();
        if channels.is_empty() {
            return Ok(());
        }

        for channel in &channels {
            membership.subscribed_channels.remove(channel);
        }
        membership.agent.unsubscribe_channels(channels).await
    }

    pub fn agent_for(&self, workspace: Option<&WorkspaceRef>) -> Result<&AgentClient> {
        Ok(&self.membership_for_ref(workspace)?.agent)
    }

    pub async fn send(&self, target: WorkspaceSendTarget) -> Result<MessageWithMeta> {
        let workspace = WorkspaceRef {
            workspace_id: target.workspace_id.clone(),
            workspace_alias: target.workspace_alias.clone(),
        };
        let membership = self.membership_for_ref(Some(&workspace))?;
        membership
            .agent
            .send(
                &target.to,
                &target.message,
                target.attachments.clone(),
                target.blocks.clone(),
                target.idempotency_key.clone(),
            )
            .await
    }

    fn start_forwarders(&mut self, workspace_id: &str) -> Result<()> {
        let membership = self.memberships.get_mut(workspace_id).unwrap();
        let scope = WorkspaceScope::from_config(&membership.config);

        if membership.event_task.is_none() {
            let mut event_rx = membership.agent.subscribe_events()?;
            let event_tx = self.event_tx.clone();
            let event_scope = scope.clone();
            membership.event_task = Some(tokio::spawn(async move {
                while let Ok(event) = event_rx.recv().await {
                    let _ = event_tx.send(event_scope.scope_event(event));
                }
            }));
        }

        if membership.lifecycle_task.is_none() {
            let mut lifecycle_rx = membership.agent.subscribe_lifecycle()?;
            let lifecycle_tx = self.lifecycle_tx.clone();
            let lifecycle_scope = scope;
            let connected = membership.connected.clone();
            membership.lifecycle_task = Some(tokio::spawn(async move {
                while let Ok(event) = lifecycle_rx.recv().await {
                    match &event {
                        WsLifecycleEvent::Open => connected.store(true, Ordering::SeqCst),
                        WsLifecycleEvent::Close | WsLifecycleEvent::Reconnecting { .. } => {
                            connected.store(false, Ordering::SeqCst)
                        }
                        WsLifecycleEvent::Error(_) => {}
                    }
                    let _ = lifecycle_tx.send(lifecycle_scope.scope_event(event));
                }
            }));
        }

        Ok(())
    }

    fn membership_for_ref(&self, workspace: Option<&WorkspaceRef>) -> Result<&WorkspaceMembership> {
        let workspace_id = self.resolve_workspace_id(workspace)?;
        self.memberships.get(&workspace_id).ok_or_else(|| {
            RelayError::InvalidResponse(format!(
                "Workspace membership not found for workspace_id \"{}\".",
                workspace_id
            ))
        })
    }

    fn resolve_workspace_id(&self, workspace: Option<&WorkspaceRef>) -> Result<String> {
        let workspace_id = workspace
            .and_then(|workspace| workspace.workspace_id.as_deref())
            .map(str::trim)
            .filter(|workspace_id| !workspace_id.is_empty());
        if let Some(workspace_id) = workspace_id {
            if self.memberships.contains_key(workspace_id) {
                return Ok(workspace_id.to_string());
            }
            return Err(RelayError::InvalidResponse(format!(
                "Workspace membership not found for workspace_id \"{}\".",
                workspace_id
            )));
        }

        let workspace_alias = workspace
            .and_then(|workspace| workspace.workspace_alias.as_deref())
            .map(str::trim)
            .filter(|workspace_alias| !workspace_alias.is_empty());
        if let Some(workspace_alias) = workspace_alias {
            if let Some(workspace_id) = self.workspace_order.iter().find(|workspace_id| {
                self.memberships
                    .get(*workspace_id)
                    .and_then(|membership| membership.config.workspace_alias.as_deref())
                    == Some(workspace_alias)
            }) {
                return Ok(workspace_id.clone());
            }
            return Err(RelayError::InvalidResponse(format!(
                "Workspace membership not found for workspace_alias \"{}\".",
                workspace_alias
            )));
        }

        if self.workspace_order.len() == 1 {
            return Ok(self.workspace_order[0].clone());
        }

        if let Some(default_workspace_id) = self.default_workspace_id.as_deref() {
            return Ok(default_workspace_id.to_string());
        }

        Err(RelayError::InvalidResponse(
            "Ambiguous workspace selection. Provide workspace_id or workspace_alias.".to_string(),
        ))
    }
}

fn normalize_channels(channels: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for channel in channels {
        let channel = channel.trim();
        if channel.is_empty() {
            continue;
        }
        if seen.insert(channel.to_string()) {
            normalized.push(channel.to_string());
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    fn membership(workspace_id: &str, workspace_alias: Option<&str>) -> WorkspaceMembershipConfig {
        WorkspaceMembershipConfig {
            workspace_id: workspace_id.to_string(),
            workspace_alias: workspace_alias.map(ToOwned::to_owned),
            agent_token: format!("at_{}", workspace_id),
            agent_id: Some(format!("agent_{}", workspace_id)),
            agent_name: Some(format!("Agent {}", workspace_id)),
            base_url: Some("http://localhost:8080".to_string()),
            channels: vec!["general".to_string()],
        }
    }

    #[test]
    fn resolves_single_membership_without_explicit_workspace() {
        let manager =
            MultiWorkspaceSessionManager::new(vec![membership("ws_alpha", Some("alpha"))], None)
                .unwrap();

        assert_eq!(manager.resolve_workspace_id(None).unwrap(), "ws_alpha");
    }

    #[test]
    fn resolves_workspace_alias_before_default() {
        let manager = MultiWorkspaceSessionManager::new(
            vec![
                membership("ws_alpha", Some("alpha")),
                membership("ws_beta", Some("beta")),
            ],
            Some("ws_alpha".to_string()),
        )
        .unwrap();

        let workspace = WorkspaceRef {
            workspace_id: None,
            workspace_alias: Some("beta".to_string()),
        };

        assert_eq!(
            manager.resolve_workspace_id(Some(&workspace)).unwrap(),
            "ws_beta"
        );
    }

    #[test]
    fn uses_default_workspace_when_resolution_is_implicit() {
        let manager = MultiWorkspaceSessionManager::new(
            vec![
                membership("ws_alpha", Some("alpha")),
                membership("ws_beta", Some("beta")),
            ],
            Some("ws_alpha".to_string()),
        )
        .unwrap();

        assert_eq!(manager.resolve_workspace_id(None).unwrap(), "ws_alpha");
    }

    #[test]
    fn rejects_ambiguous_workspace_resolution() {
        let manager = MultiWorkspaceSessionManager::new(
            vec![
                membership("ws_alpha", Some("alpha")),
                membership("ws_beta", Some("beta")),
            ],
            None,
        )
        .unwrap();

        let err = manager.resolve_workspace_id(None).unwrap_err();
        assert!(matches!(err, RelayError::InvalidResponse(_)));
        assert!(err
            .to_string()
            .contains("Ambiguous workspace selection. Provide workspace_id or workspace_alias."));
    }
}

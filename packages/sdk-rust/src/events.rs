//! Helpers for consuming raw RelayCast WebSocket events.

use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Normalized inbound event kind for message-like WebSocket events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NormalizedEventKind {
    MessageCreated,
    DmReceived,
    ThreadReply,
    GroupDmReceived,
    Presence,
    ReactionReceived,
}

/// Normalized sender kind extracted from event metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SenderKind {
    Human,
    Agent,
    Unknown,
}

/// Suggested delivery priority for a normalized inbound event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum RelayPriority {
    P2,
    P3,
    P4,
}

/// A stable, SDK-owned shape for inbound WebSocket events that need routing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NormalizedInboundEvent {
    pub event_id: String,
    pub kind: NormalizedEventKind,
    pub from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_agent_id: Option<String>,
    pub sender_kind: SenderKind,
    pub target: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub priority: RelayPriority,
}

/// A normalized command invocation event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NormalizedCommandInvocation {
    pub command: String,
    pub channel: String,
    pub invoked_by: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handler_agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Map<String, Value>>,
}

/// Normalize a raw WebSocket event value into a routeable message-like event.
///
/// The parser accepts current top-level event fields and payload-wrapped event
/// shapes. It intentionally returns `None` for command events; use
/// [`normalize_command_invocation`] for `command.invoked`.
pub fn normalize_inbound_event(value: &Value) -> Option<NormalizedInboundEvent> {
    let accessor = EventAccessor::new(value);
    let event_type = accessor
        .field(EventNesting::Top, "type")
        .and_then(Value::as_str)?;
    let mut kind = parse_inbound_kind(event_type)?;

    if matches!(kind, NormalizedEventKind::MessageCreated)
        && extract_channel(accessor).is_none()
        && has_conversation_context(accessor)
    {
        kind = NormalizedEventKind::DmReceived;
    }

    if matches!(
        kind,
        NormalizedEventKind::MessageCreated
            | NormalizedEventKind::DmReceived
            | NormalizedEventKind::ThreadReply
            | NormalizedEventKind::GroupDmReceived
    ) {
        let has_message = accessor
            .nested(EventNesting::Message)
            .is_some_and(Value::is_object)
            || accessor
                .nested(EventNesting::PayloadMessage)
                .is_some_and(Value::is_object);
        if !has_message && extract_text(accessor).is_none() {
            return None;
        }
    }

    if matches!(kind, NormalizedEventKind::Presence) {
        let from = extract_presence_sender(accessor).unwrap_or_else(|| "unknown".to_string());
        return Some(NormalizedInboundEvent {
            event_id: format!("presence-{event_type}-{from}"),
            kind,
            from,
            sender_agent_id: None,
            sender_kind: SenderKind::Agent,
            target: String::new(),
            text: String::new(),
            thread_id: None,
            priority: RelayPriority::P4,
        });
    }

    if matches!(kind, NormalizedEventKind::ReactionReceived) {
        return normalize_reaction(accessor, event_type, kind);
    }

    let from = extract_sender(accessor).unwrap_or_else(|| "unknown".to_string());
    let sender_agent_id = extract_sender_agent_id(accessor);
    let sender_kind = parse_sender_kind(accessor);
    let target = extract_target(accessor, kind).unwrap_or_else(|| "unknown".to_string());
    let text = extract_text(accessor).unwrap_or_default();
    let thread_id = extract_thread_id(accessor);
    let event_id = extract_event_id(accessor)
        .unwrap_or_else(|| synth_event_id(event_type, &from, &target, &text, thread_id.as_deref()));
    let priority = match kind {
        NormalizedEventKind::DmReceived => RelayPriority::P2,
        NormalizedEventKind::MessageCreated
        | NormalizedEventKind::ThreadReply
        | NormalizedEventKind::GroupDmReceived => RelayPriority::P3,
        NormalizedEventKind::Presence | NormalizedEventKind::ReactionReceived => RelayPriority::P4,
    };

    Some(NormalizedInboundEvent {
        event_id,
        kind,
        from,
        sender_agent_id,
        sender_kind,
        target,
        text,
        thread_id,
        priority,
    })
}

/// Normalize a raw `command.invoked` WebSocket event.
pub fn normalize_command_invocation(value: &Value) -> Option<NormalizedCommandInvocation> {
    let event_type = value.get("type")?.as_str()?;
    if event_type != "command.invoked" {
        return None;
    }

    Some(NormalizedCommandInvocation {
        command: value.get("command")?.as_str()?.to_string(),
        channel: value
            .get("channel")
            .and_then(scalar_to_string)
            .unwrap_or_default(),
        invoked_by: value
            .get("invoked_by")
            .and_then(scalar_to_string)
            .unwrap_or_else(|| "unknown".to_string()),
        handler_agent_id: value
            .get("handler_agent_id")
            .and_then(scalar_to_string)
            .or_else(|| {
                value
                    .get("handler")
                    .and_then(|handler| handler.get("id"))
                    .and_then(scalar_to_string)
            }),
        args: value.get("args").and_then(scalar_to_string),
        parameters: value.get("parameters").and_then(Value::as_object).cloned(),
    })
}

fn normalize_reaction(
    accessor: EventAccessor<'_>,
    _event_type: &str,
    kind: NormalizedEventKind,
) -> Option<NormalizedInboundEvent> {
    let from = accessor
        .field(EventNesting::Top, "agent_name")
        .and_then(scalar_to_string)
        .unwrap_or_else(|| "unknown".to_string());
    let emoji = accessor
        .field(EventNesting::Top, "emoji")
        .and_then(scalar_to_string)
        .unwrap_or_else(|| "?".to_string());
    let message_id = accessor
        .field(EventNesting::Top, "message_id")
        .and_then(scalar_to_string)
        .unwrap_or_default();
    let channel_name = accessor
        .field(EventNesting::Top, "channel_name")
        .and_then(scalar_to_string);
    let target = match channel_name {
        Some(channel) if channel.starts_with('#') => channel,
        Some(channel) if !channel.is_empty() => format!("#{channel}"),
        _ => return None,
    };

    Some(NormalizedInboundEvent {
        event_id: format!("reaction-{message_id}-{from}-{emoji}"),
        kind,
        from: from.clone(),
        sender_agent_id: None,
        sender_kind: SenderKind::Agent,
        target,
        text: format!(
            ":{emoji}: reaction from {from} on message {message_id} (informational; no response required)"
        ),
        thread_id: None,
        priority: RelayPriority::P4,
    })
}

#[derive(Clone, Copy)]
enum EventNesting {
    Top,
    Message,
    Payload,
    PayloadMessage,
}

#[derive(Clone, Copy)]
struct EventAccessor<'a> {
    top: &'a Value,
    message: Option<&'a Value>,
    payload: Option<&'a Value>,
    payload_message: Option<&'a Value>,
}

impl<'a> EventAccessor<'a> {
    fn new(top: &'a Value) -> Self {
        let payload = top.get("payload");
        let message = top.get("message");
        let payload_message = payload.and_then(|nested| nested.get("message"));

        Self {
            top,
            message,
            payload,
            payload_message,
        }
    }

    fn nested(self, nesting: EventNesting) -> Option<&'a Value> {
        match nesting {
            EventNesting::Top => Some(self.top),
            EventNesting::Message => self.message,
            EventNesting::Payload => self.payload,
            EventNesting::PayloadMessage => self.payload_message,
        }
    }

    fn field(self, nesting: EventNesting, key: &str) -> Option<&'a Value> {
        self.nested(nesting)?.get(key)
    }

    fn agent_name(self, nesting: EventNesting) -> Option<&'a Value> {
        self.field(nesting, "agent")
            .and_then(|agent| agent.get("name"))
    }

    fn first_string<F>(
        self,
        candidates: &[(EventNesting, &str)],
        mut convert: F,
        require_non_empty: bool,
    ) -> Option<String>
    where
        F: FnMut(&Value) -> Option<String>,
    {
        for (nesting, key) in candidates {
            if let Some(value) = self.field(*nesting, key).and_then(&mut convert) {
                if !require_non_empty || !value.is_empty() {
                    return Some(value);
                }
            }
        }
        None
    }

    fn first_agent_name(self, nestings: &[EventNesting]) -> Option<String> {
        for nesting in nestings {
            if let Some(name) = self.agent_name(*nesting).and_then(scalar_to_string) {
                if !name.is_empty() {
                    return Some(name);
                }
            }
        }
        None
    }

    fn has_trimmed_non_empty_scalar(self, candidates: &[(EventNesting, &str)]) -> bool {
        candidates.iter().any(|(nesting, key)| {
            self.field(*nesting, key)
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
        })
    }
}

fn parse_inbound_kind(event_type: &str) -> Option<NormalizedEventKind> {
    match event_type {
        "message.created" | "message.received" | "message.new" | "message.sent"
        | "message.delivered" => Some(NormalizedEventKind::MessageCreated),
        "dm.received"
        | "dm.created"
        | "dm.new"
        | "dm.sent"
        | "dm.message.created"
        | "direct_message.received"
        | "direct_message.created"
        | "direct_message.new"
        | "direct_message.sent" => Some(NormalizedEventKind::DmReceived),
        "thread.reply" | "thread.message.created" | "thread.message.sent" => {
            Some(NormalizedEventKind::ThreadReply)
        }
        "group_dm.received"
        | "group_dm.created"
        | "group_dm.new"
        | "group_dm.sent"
        | "group_dm.message.created" => Some(NormalizedEventKind::GroupDmReceived),
        "agent.status.changed"
        | "agent.status.idle"
        | "agent.status.active"
        | "agent.status.blocked"
        | "agent.status.waiting"
        | "agent.status.offline"
        | "user.online"
        | "user.offline" => Some(NormalizedEventKind::Presence),
        "message.reacted" => Some(NormalizedEventKind::ReactionReceived),
        _ => None,
    }
}

fn extract_presence_sender(accessor: EventAccessor<'_>) -> Option<String> {
    const AGENT_NAME_NESTINGS: [EventNesting; 2] = [EventNesting::Top, EventNesting::Payload];
    const AGENT_NAME_FIELDS: [(EventNesting, &str); 2] = [
        (EventNesting::Top, "agent_name"),
        (EventNesting::Payload, "agent_name"),
    ];
    const FROM_FIELDS: [(EventNesting, &str); 2] =
        [(EventNesting::Top, "from"), (EventNesting::Payload, "from")];

    accessor
        .first_agent_name(&AGENT_NAME_NESTINGS)
        .or_else(|| accessor.first_string(&AGENT_NAME_FIELDS, scalar_to_string, true))
        .or_else(|| accessor.first_string(&FROM_FIELDS, scalar_to_string, true))
}

fn extract_event_id(accessor: EventAccessor<'_>) -> Option<String> {
    const EVENT_ID_FIELDS: [(EventNesting, &str); 12] = [
        (EventNesting::Top, "event_id"),
        (EventNesting::Top, "message_id"),
        (EventNesting::Top, "id"),
        (EventNesting::Message, "event_id"),
        (EventNesting::Message, "message_id"),
        (EventNesting::Message, "id"),
        (EventNesting::Payload, "event_id"),
        (EventNesting::Payload, "message_id"),
        (EventNesting::Payload, "id"),
        (EventNesting::PayloadMessage, "event_id"),
        (EventNesting::PayloadMessage, "message_id"),
        (EventNesting::PayloadMessage, "id"),
    ];

    accessor.first_string(&EVENT_ID_FIELDS, scalar_to_string, true)
}

fn extract_sender_agent_id(accessor: EventAccessor<'_>) -> Option<String> {
    const FIELDS: [(EventNesting, &str); 4] = [
        (EventNesting::Message, "agent_id"),
        (EventNesting::PayloadMessage, "agent_id"),
        (EventNesting::Top, "agent_id"),
        (EventNesting::Payload, "agent_id"),
    ];

    accessor.first_string(&FIELDS, scalar_to_string, true)
}

fn extract_sender(accessor: EventAccessor<'_>) -> Option<String> {
    const TOP_AGENT_NESTINGS: [EventNesting; 1] = [EventNesting::Top];
    const TOP_FIELDS: [(EventNesting, &str); 6] = [
        (EventNesting::Top, "from"),
        (EventNesting::Top, "sender"),
        (EventNesting::Top, "author"),
        (EventNesting::Top, "from_agent"),
        (EventNesting::Top, "agent"),
        (EventNesting::Top, "agent_name"),
    ];
    const MESSAGE_FIELDS: [(EventNesting, &str); 6] = [
        (EventNesting::Message, "from"),
        (EventNesting::Message, "sender"),
        (EventNesting::Message, "author"),
        (EventNesting::Message, "from_agent"),
        (EventNesting::Message, "agent"),
        (EventNesting::Message, "agent_name"),
    ];
    const PAYLOAD_AGENT_NESTINGS: [EventNesting; 1] = [EventNesting::Payload];
    const PAYLOAD_FIELDS: [(EventNesting, &str); 6] = [
        (EventNesting::Payload, "from"),
        (EventNesting::Payload, "sender"),
        (EventNesting::Payload, "author"),
        (EventNesting::Payload, "from_agent"),
        (EventNesting::Payload, "agent"),
        (EventNesting::Payload, "agent_name"),
    ];
    const PAYLOAD_MESSAGE_FIELDS: [(EventNesting, &str); 6] = [
        (EventNesting::PayloadMessage, "from"),
        (EventNesting::PayloadMessage, "sender"),
        (EventNesting::PayloadMessage, "author"),
        (EventNesting::PayloadMessage, "from_agent"),
        (EventNesting::PayloadMessage, "agent"),
        (EventNesting::PayloadMessage, "agent_name"),
    ];

    let raw = accessor
        .first_agent_name(&TOP_AGENT_NESTINGS)
        .or_else(|| accessor.first_string(&TOP_FIELDS, sender_value_to_string, true))
        .or_else(|| accessor.first_string(&MESSAGE_FIELDS, sender_value_to_string, true))
        .or_else(|| accessor.first_agent_name(&PAYLOAD_AGENT_NESTINGS))
        .or_else(|| accessor.first_string(&PAYLOAD_FIELDS, sender_value_to_string, true))
        .or_else(|| accessor.first_string(&PAYLOAD_MESSAGE_FIELDS, sender_value_to_string, true))?;

    Some(normalize_sender_identity(&raw))
}

/// Normalize relay infrastructure sender identities to a stable display name.
pub fn normalize_sender_identity(raw: &str) -> String {
    if raw == "broker" || raw.starts_with("broker-") || raw.starts_with("human:") {
        return "Dashboard".to_string();
    }
    raw.to_string()
}

fn extract_target(accessor: EventAccessor<'_>, kind: NormalizedEventKind) -> Option<String> {
    const EXPLICIT_TARGET_FIELDS: [(EventNesting, &str); 20] = [
        (EventNesting::Top, "target"),
        (EventNesting::Top, "to"),
        (EventNesting::Top, "recipient"),
        (EventNesting::Top, "to_agent"),
        (EventNesting::Top, "recipient_agent"),
        (EventNesting::Message, "target"),
        (EventNesting::Message, "to"),
        (EventNesting::Message, "recipient"),
        (EventNesting::Message, "to_agent"),
        (EventNesting::Message, "recipient_agent"),
        (EventNesting::Payload, "target"),
        (EventNesting::Payload, "to"),
        (EventNesting::Payload, "recipient"),
        (EventNesting::Payload, "to_agent"),
        (EventNesting::Payload, "recipient_agent"),
        (EventNesting::PayloadMessage, "target"),
        (EventNesting::PayloadMessage, "to"),
        (EventNesting::PayloadMessage, "recipient"),
        (EventNesting::PayloadMessage, "to_agent"),
        (EventNesting::PayloadMessage, "recipient_agent"),
    ];
    const CONVERSATION_DM_FIELDS: [(EventNesting, &str); 2] = [
        (EventNesting::Top, "conversation_id"),
        (EventNesting::Payload, "conversation_id"),
    ];
    const CONVERSATION_FIELDS: [(EventNesting, &str); 4] = [
        (EventNesting::Top, "conversation_id"),
        (EventNesting::Message, "conversation_id"),
        (EventNesting::Payload, "conversation_id"),
        (EventNesting::PayloadMessage, "conversation_id"),
    ];

    if matches!(
        kind,
        NormalizedEventKind::DmReceived | NormalizedEventKind::GroupDmReceived
    ) {
        if let Some(target) =
            accessor.first_string(&EXPLICIT_TARGET_FIELDS, sender_value_to_string, true)
        {
            return Some(target);
        }
        if let Some(target) = accessor.first_string(&CONVERSATION_DM_FIELDS, scalar_to_string, true)
        {
            return Some(target);
        }
    }

    if let Some(channel) = extract_channel(accessor) {
        return Some(channel);
    }

    if let Some(target) =
        accessor.first_string(&EXPLICIT_TARGET_FIELDS, sender_value_to_string, true)
    {
        return Some(target);
    }

    if let Some(target) = accessor.first_string(&CONVERSATION_FIELDS, scalar_to_string, true) {
        return Some(target);
    }

    if matches!(kind, NormalizedEventKind::ThreadReply) {
        return Some("thread".to_string());
    }

    None
}

fn has_conversation_context(accessor: EventAccessor<'_>) -> bool {
    const CONVERSATION_FIELDS: [(EventNesting, &str); 4] = [
        (EventNesting::Top, "conversation_id"),
        (EventNesting::Message, "conversation_id"),
        (EventNesting::Payload, "conversation_id"),
        (EventNesting::PayloadMessage, "conversation_id"),
    ];

    accessor.has_trimmed_non_empty_scalar(&CONVERSATION_FIELDS)
}

fn synth_event_id(
    event_type: &str,
    from: &str,
    target: &str,
    text: &str,
    thread_id: Option<&str>,
) -> String {
    let mut hasher = DefaultHasher::new();
    event_type.hash(&mut hasher);
    from.hash(&mut hasher);
    target.hash(&mut hasher);
    text.hash(&mut hasher);
    thread_id.unwrap_or_default().hash(&mut hasher);
    format!("synthetic-{event_type}-{:016x}", hasher.finish())
}

fn extract_channel(accessor: EventAccessor<'_>) -> Option<String> {
    const CHANNEL_FIELDS: [(EventNesting, &str); 4] = [
        (EventNesting::Top, "channel"),
        (EventNesting::Message, "channel"),
        (EventNesting::Payload, "channel"),
        (EventNesting::PayloadMessage, "channel"),
    ];

    for (nesting, key) in CHANNEL_FIELDS {
        if let Some(raw) = accessor.field(nesting, key).and_then(scalar_to_string) {
            if raw.is_empty() {
                continue;
            }
            if raw.starts_with('#') {
                return Some(raw);
            }
            return Some(format!("#{raw}"));
        }
    }
    None
}

fn extract_text(accessor: EventAccessor<'_>) -> Option<String> {
    const TEXT_FIELDS: [(EventNesting, &str); 12] = [
        (EventNesting::Top, "text"),
        (EventNesting::Top, "body"),
        (EventNesting::Top, "content"),
        (EventNesting::Message, "text"),
        (EventNesting::Message, "body"),
        (EventNesting::Message, "content"),
        (EventNesting::Payload, "text"),
        (EventNesting::Payload, "body"),
        (EventNesting::Payload, "content"),
        (EventNesting::PayloadMessage, "text"),
        (EventNesting::PayloadMessage, "body"),
        (EventNesting::PayloadMessage, "content"),
    ];

    if let Some(text) = accessor.first_string(&TEXT_FIELDS, scalar_to_string, false) {
        return Some(text);
    }

    if let Some(raw_message) = accessor
        .field(EventNesting::Top, "message")
        .and_then(Value::as_str)
    {
        return Some(raw_message.to_string());
    }
    if let Some(raw_message) = accessor
        .field(EventNesting::Payload, "message")
        .and_then(Value::as_str)
    {
        return Some(raw_message.to_string());
    }

    None
}

fn extract_thread_id(accessor: EventAccessor<'_>) -> Option<String> {
    const THREAD_FIELDS: [(EventNesting, &str); 6] = [
        (EventNesting::Top, "parent_id"),
        (EventNesting::Top, "thread_id"),
        (EventNesting::Message, "thread_id"),
        (EventNesting::Payload, "parent_id"),
        (EventNesting::Payload, "thread_id"),
        (EventNesting::PayloadMessage, "thread_id"),
    ];

    accessor.first_string(&THREAD_FIELDS, scalar_to_string, true)
}

fn sender_value_to_string(value: &Value) -> Option<String> {
    if let Some(s) = scalar_to_string(value) {
        return Some(s);
    }

    let obj = value.as_object()?;
    for key in ["name", "display_name", "username", "handle", "id"] {
        if let Some(v) = obj.get(key) {
            if let Some(s) = scalar_to_string(v) {
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
    }
    None
}

fn scalar_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn parse_sender_kind(accessor: EventAccessor<'_>) -> SenderKind {
    const KIND_FIELDS: [(EventNesting, &str); 24] = [
        (EventNesting::Top, "from_type"),
        (EventNesting::Top, "sender_type"),
        (EventNesting::Top, "actor_type"),
        (EventNesting::Top, "source_type"),
        (EventNesting::Top, "origin_type"),
        (EventNesting::Top, "sender_kind"),
        (EventNesting::Message, "from_type"),
        (EventNesting::Message, "sender_type"),
        (EventNesting::Message, "actor_type"),
        (EventNesting::Message, "source_type"),
        (EventNesting::Message, "origin_type"),
        (EventNesting::Message, "sender_kind"),
        (EventNesting::Payload, "from_type"),
        (EventNesting::Payload, "sender_type"),
        (EventNesting::Payload, "actor_type"),
        (EventNesting::Payload, "source_type"),
        (EventNesting::Payload, "origin_type"),
        (EventNesting::Payload, "sender_kind"),
        (EventNesting::PayloadMessage, "from_type"),
        (EventNesting::PayloadMessage, "sender_type"),
        (EventNesting::PayloadMessage, "actor_type"),
        (EventNesting::PayloadMessage, "source_type"),
        (EventNesting::PayloadMessage, "origin_type"),
        (EventNesting::PayloadMessage, "sender_kind"),
    ];
    const CONTAINER_NESTINGS: [EventNesting; 4] = [
        EventNesting::Top,
        EventNesting::Message,
        EventNesting::Payload,
        EventNesting::PayloadMessage,
    ];

    for (nesting, key) in KIND_FIELDS {
        if let Some(kind) = accessor
            .field(nesting, key)
            .and_then(Value::as_str)
            .and_then(parse_sender_kind_label)
        {
            return kind;
        }
    }

    for nesting in CONTAINER_NESTINGS {
        if let Some(kind) = accessor
            .nested(nesting)
            .and_then(Value::as_object)
            .and_then(parse_sender_kind_from_containers)
        {
            return kind;
        }
    }

    SenderKind::Unknown
}

fn parse_sender_kind_label(raw: &str) -> Option<SenderKind> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "human" | "user" => Some(SenderKind::Human),
        "agent" | "bot" | "assistant" => Some(SenderKind::Agent),
        _ => None,
    }
}

fn parse_sender_kind_from_containers(payload: &Map<String, Value>) -> Option<SenderKind> {
    for container in ["from", "sender", "author"] {
        if let Some(kind) = payload
            .get(container)
            .and_then(Value::as_object)
            .and_then(|obj| {
                obj.get("type")
                    .or_else(|| obj.get("kind"))
                    .or_else(|| obj.get("role"))
            })
            .and_then(Value::as_str)
            .and_then(parse_sender_kind_label)
        {
            return Some(kind);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        normalize_command_invocation, normalize_inbound_event, normalize_sender_identity,
        NormalizedEventKind, RelayPriority, SenderKind,
    };

    #[test]
    fn normalizes_message_created_top_level() {
        let event = normalize_inbound_event(&json!({
            "type": "message.created",
            "channel": "general",
            "message": {
                "id": "msg_1",
                "agent_id": "agent_1",
                "agent_name": "alice",
                "text": "hello"
            }
        }))
        .expect("message event should normalize");

        assert_eq!(event.kind, NormalizedEventKind::MessageCreated);
        assert_eq!(event.event_id, "msg_1");
        assert_eq!(event.from, "alice");
        assert_eq!(event.sender_agent_id.as_deref(), Some("agent_1"));
        assert_eq!(event.target, "#general");
        assert_eq!(event.text, "hello");
        assert_eq!(event.priority, RelayPriority::P3);
    }

    #[test]
    fn normalizes_payload_wrapped_dm() {
        let event = normalize_inbound_event(&json!({
            "type": "dm.received",
            "payload": {
                "conversation_id": "dm_1",
                "message": {
                    "id": "msg_2",
                    "agent_name": "broker",
                    "text": "ping"
                }
            }
        }))
        .expect("payload-wrapped dm should normalize");

        assert_eq!(event.kind, NormalizedEventKind::DmReceived);
        assert_eq!(event.from, "Dashboard");
        assert_eq!(event.target, "dm_1");
        assert_eq!(event.text, "ping");
        assert_eq!(event.priority, RelayPriority::P2);
    }

    #[test]
    fn treats_message_created_with_conversation_as_dm() {
        let event = normalize_inbound_event(&json!({
            "type": "message.created",
            "conversation_id": "dm_2",
            "message": {
                "id": "msg_3",
                "agent_name": "lead",
                "text": "direct"
            }
        }))
        .expect("conversation message should normalize");

        assert_eq!(event.kind, NormalizedEventKind::DmReceived);
        assert_eq!(event.target, "dm_2");
    }

    #[test]
    fn normalizes_reaction_with_channel_context() {
        let event = normalize_inbound_event(&json!({
            "type": "message.reacted",
            "message_id": "msg_4",
            "agent_name": "alice",
            "emoji": "eyes",
            "action": "added",
            "channel_name": "general"
        }))
        .expect("reaction should normalize");

        assert_eq!(event.kind, NormalizedEventKind::ReactionReceived);
        assert_eq!(event.target, "#general");
        assert_eq!(event.priority, RelayPriority::P4);
    }

    #[test]
    fn normalizes_command_invocation() {
        let command = normalize_command_invocation(&json!({
            "type": "command.invoked",
            "command": "/spawn",
            "channel": "general",
            "invoked_by": "lead",
            "handler": { "id": "agent_handler" },
            "args": "worker-1",
            "parameters": { "name": "worker-1", "cli": "codex" }
        }))
        .expect("command should normalize");

        assert_eq!(command.command, "/spawn");
        assert_eq!(command.handler_agent_id.as_deref(), Some("agent_handler"));
        assert_eq!(
            command
                .parameters
                .as_ref()
                .and_then(|params| params.get("cli"))
                .and_then(|value| value.as_str()),
            Some("codex")
        );
    }

    #[test]
    fn extracts_sender_kind_from_nested_object() {
        let event = normalize_inbound_event(&json!({
            "type": "dm.received",
            "conversation_id": "dm_3",
            "message": {
                "id": "msg_5",
                "from": { "name": "Will", "type": "human" },
                "text": "hello"
            }
        }))
        .expect("nested sender should normalize");

        assert_eq!(event.from, "Will");
        assert_eq!(event.sender_kind, SenderKind::Human);
    }

    #[test]
    fn rejects_malformed_message_events() {
        assert!(normalize_inbound_event(&json!({
            "type": "message.created",
            "channel": "general"
        }))
        .is_none());
    }

    #[test]
    fn normalizes_infrastructure_sender_identity() {
        assert_eq!(normalize_sender_identity("broker"), "Dashboard");
        assert_eq!(normalize_sender_identity("broker-abc123"), "Dashboard");
        assert_eq!(normalize_sender_identity("human:orchestrator"), "Dashboard");
        assert_eq!(normalize_sender_identity("alice"), "alice");
    }
}

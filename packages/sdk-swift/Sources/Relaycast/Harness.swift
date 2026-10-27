import Foundation

public let relaycastHarnessHeader = "X-Relaycast-Harness"
public let agentRelayDistinctIDHeader = "X-Agent-Relay-Distinct-Id"
public let agentRelayDistinctIDQuery = "agent_relay_distinct_id"

private let harnessMaxLength = 120
private let agentRelayDistinctIDMaxLength = 128

public func sanitizeHarness(_ raw: String?) -> String? {
    guard let raw else { return nil }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    guard trimmed.range(of: #"^[a-z0-9 ._\-/():=;,+]+$"#, options: [.regularExpression, .caseInsensitive]) != nil else {
        return nil
    }
    return String(trimmed.prefix(harnessMaxLength)).lowercased()
}

public func sanitizeAgentRelayDistinctID(_ raw: String?) -> String? {
    guard let raw else { return nil }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    guard trimmed.range(of: #"^[a-z0-9._:-]+$"#, options: [.regularExpression, .caseInsensitive]) != nil else {
        return nil
    }
    return String(trimmed.prefix(agentRelayDistinctIDMaxLength))
}

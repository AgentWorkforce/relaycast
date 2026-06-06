import Foundation

public enum RelayError: Error, LocalizedError {
    case api(code: String, message: String, statusCode: Int?, retryable: Bool)
    case transport(message: String, statusCode: Int?, retryable: Bool, cause: Error?)
    case invalidRequest(String)
    case invalidResponse(String, statusCode: Int?)
    case missingData(String)
    case notConnected

    public var errorDescription: String? {
        switch self {
        case .api(_, let message, _, _):
            return message
        case .transport(let message, _, _, _):
            return message
        case .invalidRequest(let message):
            return message
        case .invalidResponse(let message, _):
            return message
        case .missingData(let message):
            return message
        case .notConnected:
            return "WebSocket is not connected"
        }
    }

    public var code: String {
        switch self {
        case .api(let code, _, _, _):
            return code
        case .transport:
            return "transport_error"
        case .invalidRequest:
            return "invalid_request"
        case .invalidResponse:
            return "invalid_response"
        case .missingData:
            return "missing_data"
        case .notConnected:
            return "not_connected"
        }
    }

    public var statusCode: Int? {
        switch self {
        case .api(_, _, let statusCode, _),
             .transport(_, let statusCode, _, _),
             .invalidResponse(_, let statusCode):
            return statusCode
        case .invalidRequest, .missingData, .notConnected:
            return nil
        }
    }

    public var retryable: Bool {
        switch self {
        case .api(_, _, _, let retryable),
             .transport(_, _, let retryable, _):
            return retryable
        case .invalidRequest, .invalidResponse, .missingData, .notConnected:
            return false
        }
    }
}

func relayErrorFromAPI(code: String, message: String, statusCode: Int?) -> RelayError {
    let retryableStatus = statusCode.map { [429, 500, 502, 503, 504].contains($0) } ?? false
    return .api(code: normalizeRelayErrorCode(code), message: message, statusCode: statusCode, retryable: retryableStatus)
}

public func normalizeRelayErrorCode(_ code: String) -> String {
    let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "unknown_error" : trimmed
}

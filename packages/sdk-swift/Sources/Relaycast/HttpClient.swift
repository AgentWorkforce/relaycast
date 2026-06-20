import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct RetryPolicy: Equatable, Sendable {
    public var maxRetries: Int
    public var backoffMilliseconds: Int
    public var backoffMultiplier: Double
    public var jitter: Bool
    public var retryOn: Set<Int>

    public init(
        maxRetries: Int = 3,
        backoffMilliseconds: Int = 1_000,
        backoffMultiplier: Double = 2,
        jitter: Bool = true,
        retryOn: Set<Int> = [429, 500, 502, 503, 504]
    ) {
        self.maxRetries = max(0, maxRetries)
        self.backoffMilliseconds = max(0, backoffMilliseconds)
        self.backoffMultiplier = max(1, backoffMultiplier)
        self.jitter = jitter
        self.retryOn = retryOn.filter { $0 >= 100 }
    }
}

public struct ClientOptions: Equatable, Sendable {
    public var apiKey: String
    public var baseURL: String?
    public var retryPolicy: RetryPolicy
    public var harness: String?
    public var agentRelayDistinctID: String?
    public var originSurface: String?
    public var originClient: String?
    public var originVersion: String?

    public init(
        apiKey: String,
        baseURL: String? = nil,
        retryPolicy: RetryPolicy = RetryPolicy(),
        harness: String? = nil,
        agentRelayDistinctID: String? = nil,
        originSurface: String? = nil,
        originClient: String? = nil,
        originVersion: String? = nil
    ) {
        self.apiKey = apiKey
        self.baseURL = baseURL
        self.retryPolicy = retryPolicy
        self.harness = harness
        self.agentRelayDistinctID = agentRelayDistinctID
        self.originSurface = originSurface
        self.originClient = originClient
        self.originVersion = originVersion
    }
}

public struct RequestOptions: Equatable, Sendable {
    public var headers: [String: String]
    public var idempotencyKey: String?

    public init(headers: [String: String] = [:], idempotencyKey: String? = nil) {
        self.headers = headers
        self.idempotencyKey = idempotencyKey
    }
}

public final class HttpClient: @unchecked Sendable {
    public let apiKey: String
    public let baseURL: URL
    public let retryPolicy: RetryPolicy
    public let originSurface: String
    public let originClient: String
    public let originVersion: String
    public let harness: String?
    public let agentRelayDistinctID: String?

    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(options: ClientOptions, session: URLSession = .shared) throws {
        guard let baseURL = URL(string: options.baseURL ?? "https://cast.agentrelay.com") else {
            throw RelayError.invalidRequest("Invalid Relaycast baseURL")
        }
        self.apiKey = options.apiKey
        self.baseURL = baseURL
        self.retryPolicy = options.retryPolicy
        self.originSurface = options.originSurface ?? RelaycastOrigin.surface
        self.originClient = options.originClient ?? RelaycastOrigin.client
        self.originVersion = options.originVersion ?? RelaycastOrigin.version
        self.harness = sanitizeHarness(options.harness)
        self.agentRelayDistinctID = sanitizeAgentRelayDistinctID(options.agentRelayDistinctID)
        self.session = session
        self.encoder = makeRelaycastEncoder()
        self.decoder = makeRelaycastDecoder()
    }

    public func withApiKey(_ apiKey: String) throws -> HttpClient {
        try HttpClient(
            options: ClientOptions(
                apiKey: apiKey,
                baseURL: baseURL.absoluteString,
                retryPolicy: retryPolicy,
                harness: harness,
                agentRelayDistinctID: agentRelayDistinctID,
                originSurface: originSurface,
                originClient: originClient,
                originVersion: originVersion
            ),
            session: session
        )
    }

    public func get<T: Decodable>(
        _ path: String,
        query: [String: String] = [:],
        options: RequestOptions = RequestOptions()
    ) async throws -> T {
        try await request("GET", path: path, body: Optional<EmptyRequest>.none, query: query, options: options)
    }

    public func post<T: Decodable, Body: Encodable>(
        _ path: String,
        body: Body,
        options: RequestOptions = RequestOptions()
    ) async throws -> T {
        try await request("POST", path: path, body: body, options: options)
    }

    public func post<T: Decodable>(
        _ path: String,
        options: RequestOptions = RequestOptions()
    ) async throws -> T {
        try await request("POST", path: path, body: EmptyRequest(), options: options)
    }

    public func patch<T: Decodable, Body: Encodable>(
        _ path: String,
        body: Body,
        options: RequestOptions = RequestOptions()
    ) async throws -> T {
        try await request("PATCH", path: path, body: body, options: options)
    }

    public func put<T: Decodable, Body: Encodable>(
        _ path: String,
        body: Body,
        options: RequestOptions = RequestOptions()
    ) async throws -> T {
        try await request("PUT", path: path, body: body, options: options)
    }

    @discardableResult
    public func delete(
        _ path: String,
        options: RequestOptions = RequestOptions()
    ) async throws -> EmptyResponse {
        try await request("DELETE", path: path, body: Optional<EmptyRequest>.none, options: options)
    }

    public func request<T: Decodable, Body: Encodable>(
        _ method: String,
        path: String,
        body: Body? = nil,
        query: [String: String] = [:],
        options: RequestOptions = RequestOptions()
    ) async throws -> T {
        var attempt = 0

        while true {
            do {
                let request = try buildRequest(method, path: path, body: body, query: query, options: options)
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw RelayError.transport(message: "Relaycast response was not HTTP", statusCode: nil, retryable: true, cause: nil)
                }

                if retryPolicy.retryOn.contains(http.statusCode), attempt < retryPolicy.maxRetries {
                    let delay = retryDelayMilliseconds(policy: retryPolicy, attempt: attempt, response: http)
                    attempt += 1
                    try await sleep(milliseconds: delay)
                    continue
                }

                if http.statusCode == 204 {
                    guard let empty = EmptyResponse() as? T else {
                        throw RelayError.missingData("Relaycast returned no content")
                    }
                    return empty
                }

                let envelope: ApiResponse<T>
                do {
                    envelope = try decoder.decode(ApiResponse<T>.self, from: data)
                } catch {
                    throw RelayError.invalidResponse("Invalid Relaycast API response", statusCode: http.statusCode)
                }

                guard envelope.ok else {
                    let code = envelope.error?.code ?? "unknown_error"
                    let message = envelope.error?.message ?? "Unknown error"
                    throw relayErrorFromAPI(code: code, message: message, statusCode: http.statusCode)
                }

                if let value = envelope.data {
                    return value
                }

                if let empty = EmptyResponse() as? T {
                    return empty
                }

                throw RelayError.missingData("Relaycast API response was missing data")
            } catch let error as RelayError {
                throw error
            } catch {
                if attempt < retryPolicy.maxRetries {
                    let delay = retryDelayMilliseconds(policy: retryPolicy, attempt: attempt, response: nil)
                    attempt += 1
                    try await sleep(milliseconds: delay)
                    continue
                }
                throw RelayError.transport(
                    message: "Network request failed: \(error.localizedDescription)",
                    statusCode: nil,
                    retryable: true,
                    cause: error
                )
            }
        }
    }

    private func buildRequest<Body: Encodable>(
        _ method: String,
        path: String,
        body: Body?,
        query: [String: String],
        options: RequestOptions
    ) throws -> URLRequest {
        guard let url = url(path: path, query: query) else {
            throw RelayError.invalidRequest("Invalid Relaycast request URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue(relaycastSDKVersion, forHTTPHeaderField: "X-SDK-Version")
        request.setValue(originSurface, forHTTPHeaderField: "X-Relaycast-Origin-Surface")
        request.setValue(originClient, forHTTPHeaderField: "X-Relaycast-Origin-Client")
        request.setValue(originVersion, forHTTPHeaderField: "X-Relaycast-Origin-Version")

        if let harness {
            request.setValue(harness, forHTTPHeaderField: relaycastHarnessHeader)
        }
        if let agentRelayDistinctID {
            request.setValue(agentRelayDistinctID, forHTTPHeaderField: agentRelayDistinctIDHeader)
        }

        if let key = options.idempotencyKey {
            for (name, value) in idempotencyHeaders(key) {
                request.setValue(value, forHTTPHeaderField: name)
            }
        }

        for (name, value) in options.headers {
            request.setValue(value, forHTTPHeaderField: name)
        }

        if let body, method.uppercased() != "GET" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try encoder.encode(body)
        }

        return request
    }

    private func url(path: String, query: [String: String]) -> URL? {
        let target = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let base = baseURL.absoluteString.hasSuffix("/") ? baseURL : baseURL.appendingPathComponent("")
        guard let rawURL = URL(string: target, relativeTo: base)?.absoluteURL else {
            return nil
        }
        guard !query.isEmpty else {
            return rawURL
        }

        var components = URLComponents(url: rawURL, resolvingAgainstBaseURL: false)
        var items = components?.queryItems ?? []
        items.append(contentsOf: query.map { URLQueryItem(name: snakeCase($0.key), value: $0.value) })
        components?.queryItems = items
        return components?.url
    }
}

private func retryDelayMilliseconds(policy: RetryPolicy, attempt: Int, response: HTTPURLResponse?) -> Int {
    if response?.statusCode == 429, let retryAfter = parseRetryAfterMilliseconds(response) {
        return retryAfter
    }

    let exponential = Double(policy.backoffMilliseconds) * pow(policy.backoffMultiplier, Double(attempt))
    let jitterFactor = policy.jitter ? Double.random(in: 0.5...1.5) : 1
    return max(0, Int((exponential * jitterFactor).rounded()))
}

private func parseRetryAfterMilliseconds(_ response: HTTPURLResponse?) -> Int? {
    guard let header = response?.value(forHTTPHeaderField: "Retry-After") else {
        return nil
    }

    if let seconds = Double(header) {
        return max(0, Int((seconds * 1_000).rounded()))
    }

    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss z"

    guard let date = formatter.date(from: header) else {
        return nil
    }
    return max(0, Int(date.timeIntervalSinceNow * 1_000))
}

private func sleep(milliseconds: Int) async throws {
    guard milliseconds > 0 else { return }
    try await Task.sleep(nanoseconds: UInt64(milliseconds) * 1_000_000)
}

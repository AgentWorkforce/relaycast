import Foundation

func makeRelaycastEncoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.keyEncodingStrategy = .convertToSnakeCase
    return encoder
}

func makeRelaycastDecoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return decoder
}

func snakeCase(_ key: String) -> String {
    guard !key.isEmpty else { return key }
    var output = ""
    for scalar in key.unicodeScalars {
        let char = Character(scalar)
        if CharacterSet.uppercaseLetters.contains(scalar) {
            if !output.isEmpty {
                output.append("_")
            }
            output.append(String(char).lowercased())
        } else {
            output.append(String(char))
        }
    }
    return output
}

func stripHash(_ channel: String) -> String {
    channel.hasPrefix("#") ? String(channel.dropFirst()) : channel
}

func percentEncodePathComponent(_ value: String) -> String {
    var allowed = CharacterSet.urlPathAllowed
    allowed.remove(charactersIn: "/?#[]@!$&'()*+,;=")
    return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
}

func idempotencyHeaders(_ key: String?) -> [String: String] {
    let value = key?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        ? key!
        : UUID().uuidString
    return [
        "Idempotency-Key": value,
        "X-Idempotency-Key": value
    ]
}

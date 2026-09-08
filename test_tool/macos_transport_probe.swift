import Foundation

@main
struct TransportProbe {
    static func main() async {
        // Use the production URLSession client inside an actual .app so ATS is
        // applied. Never print the origin, token, catalog titles, or raw errors.
        do {
            let args = CommandLine.arguments
            let token = try String(contentsOfFile: args[2], encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let result = try await CompanionConnectionClient().verify(origin: args[1], token: token)
            print("{\"status\":\"ready\",\"targets\":\(result.targetCount)}")
        } catch let CompanionConnectionError.rejected(status) {
            print("{\"status\":\"rejected\",\"httpStatus\":\(status)}")
        } catch {
            let code = (error as NSError).code
            print("{\"status\":\"error\",\"code\":\(code)}")
        }
    }
}

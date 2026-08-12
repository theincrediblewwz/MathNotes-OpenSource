import AppKit
import Combine
import CoreImage
import Darwin
import Foundation
import Network

struct CompanionLanAddress: Equatable, Identifiable, Sendable {
    let interfaceName: String
    let address: String

    var id: String { "\(interfaceName):\(address)" }

    func origin(port: Int) -> String {
        "http://\(address):\(port)"
    }
}

enum CompanionLanAddressDiscovery {
    static func current() -> [CompanionLanAddress] {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return [] }
        defer { freeifaddrs(first) }

        var discovered: [CompanionLanAddress] = []
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let interface = cursor {
            defer { cursor = interface.pointee.ifa_next }
            guard let socketAddress = interface.pointee.ifa_addr,
                  socketAddress.pointee.sa_family == UInt8(AF_INET) else { continue }

            let flags = Int32(interface.pointee.ifa_flags)
            guard flags & IFF_UP != 0,
                  flags & IFF_RUNNING != 0,
                  flags & IFF_LOOPBACK == 0 else { continue }

            let name = String(cString: interface.pointee.ifa_name)

            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                socketAddress,
                socklen_t(socketAddress.pointee.sa_len),
                &host,
                socklen_t(host.count),
                nil,
                0,
                NI_NUMERICHOST
            )
            guard result == 0 else { continue }
            let address = String(cString: host)
            discovered.append(CompanionLanAddress(interfaceName: name, address: address))
        }

        return usable(discovered)
    }

    static func usable(_ candidates: [CompanionLanAddress]) -> [CompanionLanAddress] {
        var seen = Set<String>()
        return candidates
            .filter { isCandidateInterface($0.interfaceName) && isRFC1918($0.address) }
            .sorted {
                let leftRank = rank($0.interfaceName)
                let rightRank = rank($1.interfaceName)
                return leftRank == rightRank ? $0.address < $1.address : leftRank < rightRank
            }
            .filter { seen.insert($0.address).inserted }
    }

    private static func isCandidateInterface(_ name: String) -> Bool {
        let normalized = name.lowercased()
        let rejectedPrefixes = [
            "lo", "utun", "awdl", "llw", "bridge", "gif", "stf", "vmnet", "vnic", "docker",
            "anpi", "ap", "p2p"
        ]
        return !rejectedPrefixes.contains { normalized.hasPrefix($0) }
    }

    private static func rank(_ interfaceName: String) -> Int {
        switch interfaceName.lowercased() {
        case "en0": 0
        case "en1": 1
        default: interfaceName.lowercased().hasPrefix("en") ? 2 : 3
        }
    }

    private static func isRFC1918(_ address: String) -> Bool {
        let octets = address.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else { return false }
        return octets[0] == 10
            || (octets[0] == 172 && (16...31).contains(octets[1]))
            || (octets[0] == 192 && octets[1] == 168)
    }
}

@MainActor
final class CompanionLanAddressMonitor: ObservableObject {
    @Published private(set) var addresses: [CompanionLanAddress] = []

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.mathnotes.companion-lan-address")

    init() {
        refresh()
        monitor.pathUpdateHandler = { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.refresh()
            }
        }
        monitor.start(queue: queue)
    }

    deinit {
        monitor.cancel()
    }

    var recommended: CompanionLanAddress? { addresses.first }

    func refresh() {
        let next = CompanionLanAddressDiscovery.current()
        if next != addresses { addresses = next }
    }
}

extension CompanionPairingChallenge {
    func pairingLink(host: String, port: Int, alternateHosts: [String]) -> String {
        var components = URLComponents()
        components.scheme = "mathnotes"
        components.host = "pair"
        components.queryItems = [
            URLQueryItem(name: "v", value: "2"),
            URLQueryItem(name: "host", value: host),
            URLQueryItem(name: "port", value: String(port)),
            URLQueryItem(name: "challenge", value: challengeId),
            URLQueryItem(name: "code", value: userCode),
            URLQueryItem(name: "expires", value: expiresAt),
            URLQueryItem(name: "transport", value: "private_http")
        ]
        let alternates = alternateHosts.filter { $0 != host }.prefix(5)
        if !alternates.isEmpty {
            components.queryItems?.append(URLQueryItem(name: "hosts", value: alternates.joined(separator: ",")))
        }
        return components.string ?? userCode
    }
}

enum CompanionPairingQRCode {
    static func image(payload: String, side: CGFloat = 180) -> NSImage? {
        guard let data = payload.data(using: .utf8) else { return nil }
        let filter = CIFilter(name: "CIQRCodeGenerator")
        filter?.setValue(data, forKey: "inputMessage")
        filter?.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter?.outputImage else { return nil }

        let extent = output.extent.integral
        let scale = max(1, floor(side / max(extent.width, extent.height)))
        let transformed = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let context = CIContext(options: [.useSoftwareRenderer: false])
        guard let cgImage = context.createCGImage(transformed, from: transformed.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: side, height: side))
    }
}

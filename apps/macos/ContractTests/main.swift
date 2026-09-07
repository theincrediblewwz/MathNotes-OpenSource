import Foundation

var failures: [String] = []
var checks = 0

let packagedVersion = MacAppVersion(info: [
    "CFBundleShortVersionString": "0.3.1",
    "CFBundleVersion": "0.3.1",
    "MathNotesBuildRevision": "abc123456789"
])
check(packagedVersion.version == "0.3.1", "settings version must come from the installed bundle")
check(packagedVersion.build == "abc123456789", "same-version packages must expose their source build")
check(packagedVersion.copyText.contains("abc123456789"), "copied version must identify the build")
check(MacAppVersion(info: [:]).version == "开发版本", "development runs must not pretend to be a release")

struct TestFailure: Error {}

func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    checks += 1
    if !condition() { failures.append(message) }
}

final class CapturingURLProtocol: URLProtocol {
    nonisolated(unsafe) static var requests: [URLRequest] = []
    nonisolated(unsafe) static var requestBodies: [Data] = []
    nonisolated(unsafe) static var response: (status: Int, body: String) = (200, "{}")

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.requests.append(request)
        Self.requestBodies.append(Self.captureBody(from: request))
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: Self.response.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.response.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func captureBody(from request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var body = Data()
        var buffer = [UInt8](repeating: 0, count: 8_192)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            body.append(contentsOf: buffer.prefix(count))
        }
        return body
    }
}

final class ResultBox<T>: @unchecked Sendable {
    nonisolated(unsafe) var value: Result<T, Error>?
}

func waitFor<T>(_ operation: @escaping () async throws -> T) -> Result<T, Error> {
    let semaphore = DispatchSemaphore(value: 0)
    let box = ResultBox<T>()
    Task {
        do { box.value = .success(try await operation()) }
        catch { box.value = .failure(error) }
        semaphore.signal()
    }
    semaphore.wait()
    return box.value!
}

do {
    let data = Data(#"{"type":"mathnotes.ready","apiVersion":1,"instanceId":"instance-1","host":"127.0.0.1","port":43123}"#.utf8)
    let ready = try JSONDecoder().decode(SidecarReadyMessage.self, from: data)
    try ready.validate()
    check(ready.endpoint?.absoluteString == "http://127.0.0.1:43123", "loopback endpoint mismatch")
} catch {
    failures.append("valid ready message failed: \(error)")
}

do {
    let data = Data(#"{"type":"mathnotes.ready","apiVersion":1,"instanceId":"instance-host","host":"127.0.0.1","port":43123,"companionHost":{"host":"0.0.0.0","port":1051,"url":"http://127.0.0.1:1051"}}"#.utf8)
    let ready = try JSONDecoder().decode(SidecarReadyMessage.self, from: data)
    try ready.validate()
    check(ready.companionHost?.endpoint?.absoluteString == "http://127.0.0.1:1051", "Companion host endpoint mismatch")
    check(ready.companionHost?.port == 1051, "Companion host port mismatch")
} catch {
    failures.append("valid Companion host message failed: \(error)")
}

do {
    let data = Data(#"{"challengeId":"challenge-1","userCode":"ABCD-2345","expiresAt":"2026-07-26T13:00:00.000Z","remainingAttempts":5}"#.utf8)
    let challenge = try JSONDecoder().decode(CompanionPairingChallenge.self, from: data)
    check(challenge.userCode == "ABCD-2345", "Companion pairing code mismatch")
    check(challenge.remainingAttempts == 5, "Companion pairing attempts mismatch")
    check(challenge.pairingLink.contains("mathnotes://pair"), "Companion pairing link scheme mismatch")
    check(challenge.pairingLink.contains("challenge=challenge-1"), "Companion pairing link challenge mismatch")
    check(challenge.pairingLink.contains("code=ABCD-2345"), "Companion pairing link code mismatch")
    let lanLink = challenge.pairingLink(
        host: "172.20.10.2",
        port: 1_051,
        alternateHosts: ["172.20.10.2", "192.168.43.12"]
    )
    check(lanLink.contains("v=2"), "LAN pairing link version mismatch")
    check(lanLink.contains("host=172.20.10.2"), "LAN pairing link host mismatch")
    check(lanLink.contains("port=1051"), "LAN pairing link port mismatch")
    check(lanLink.contains("transport=private_http"), "LAN pairing transport mismatch")
    check(lanLink.contains("hosts=192.168.43.12"), "LAN pairing alternate host mismatch")
    check(!lanLink.contains("token="), "LAN pairing link leaked the long-lived token")
    check(CompanionPairingQRCode.image(payload: lanLink, side: 96) != nil, "LAN pairing QR generation failed")
    let tailnetLink = challenge.pairingLink(
        host: "100.88.42.7",
        port: 49_194,
        alternateHosts: ["100.88.42.7", "172.20.10.2"],
        transport: .tailnetHTTP
    )
    check(tailnetLink.contains("host=100.88.42.7"), "Tailscale pairing link host mismatch")
    check(tailnetLink.contains("port=49194"), "Tailscale pairing link dynamic port mismatch")
    check(tailnetLink.contains("transport=tailnet_http"), "Tailscale pairing transport mismatch")
    check(tailnetLink.contains("hosts=172.20.10.2"), "Tailscale pairing LAN fallback mismatch")
    check(!tailnetLink.contains("token="), "Tailscale pairing link leaked the long-lived token")
    check(CompanionPairingQRCode.image(payload: tailnetLink, side: 96) != nil, "Tailscale pairing QR generation failed")
} catch {
    failures.append("Companion pairing challenge decode failed: \(error)")
}

do {
    let usable = CompanionLanAddressDiscovery.usable([
        CompanionLanAddress(interfaceName: "utun4", address: "192.168.50.3"),
        CompanionLanAddress(interfaceName: "en1", address: "192.168.1.8"),
        CompanionLanAddress(interfaceName: "en0", address: "172.20.10.2"),
        CompanionLanAddress(interfaceName: "en0", address: "172.20.10.2"),
        CompanionLanAddress(interfaceName: "en0", address: "100.85.42.7"),
        CompanionLanAddress(interfaceName: "en0", address: "169.254.1.2"),
        CompanionLanAddress(interfaceName: "en0", address: "8.8.8.8"),
        CompanionLanAddress(interfaceName: "lo0", address: "127.0.0.1")
    ])
    check(usable.map(\.address) == ["172.20.10.2", "192.168.1.8"], "LAN address filtering or ranking mismatch")
    check(usable.first?.origin(port: 1_051) == "http://172.20.10.2:1051", "LAN origin mismatch")
} catch {
    failures.append("LAN address policy failed: \(error)")
}

do {
    try SidecarReadyMessage(
        type: "mathnotes.ready",
        apiVersion: 1,
        instanceId: "invalid-host",
        host: "127.0.0.1",
        port: 43_123,
        companionHost: SidecarCompanionHost(
            host: "192.168.1.8",
            port: 1_051,
            url: "http://192.168.1.8:1051"
        )
    ).validate()
    failures.append("non-listener Companion host was accepted")
} catch SidecarProtocolError.invalidCompanionHost {
    // Expected.
} catch {
    failures.append("invalid Companion host returned unexpected error: \(error)")
}

do {
    try SidecarReadyMessage(
        type: "mathnotes.ready",
        apiVersion: 1,
        instanceId: "unsafe-url",
        host: "127.0.0.1",
        port: 43_123,
        companionHost: SidecarCompanionHost(
            host: "0.0.0.0",
            port: 1_051,
            url: "http://0.0.0.0:1051"
        )
    ).validate()
    failures.append("all-interface Companion URL was accepted as a user endpoint")
} catch SidecarProtocolError.invalidCompanionHost {
    // Expected.
} catch {
    failures.append("invalid Companion URL returned unexpected error: \(error)")
}

do {
    try SidecarReadyMessage(
        type: "mathnotes.ready",
        apiVersion: 1,
        instanceId: "remote",
        host: "0.0.0.0",
        port: 80
    ).validate()
    failures.append("remote host was accepted")
} catch SidecarProtocolError.nonLoopbackEndpoint {
    // Expected.
} catch {
    failures.append("remote host returned unexpected error: \(error)")
}

do {
    try SidecarReadyMessage(
        type: "mathnotes.ready",
        apiVersion: 2,
        instanceId: "future",
        host: "127.0.0.1",
        port: 43_123
    ).validate()
    failures.append("future API version was accepted")
} catch SidecarProtocolError.unsupportedAPIVersion(2) {
    // Expected.
} catch {
    failures.append("future API version returned unexpected error: \(error)")
}

check(SidecarState.failed("启动失败") == .failed("启动失败"), "failure state lost its message")

do {
    let tailnetAddress = try TailscaleIPv4Inspection.inspect(Data("100.88.42.7\n".utf8))
    check(tailnetAddress == "100.88.42.7", "Tailscale IPv4 inspection lost the tailnet address")
    check(TailscaleIPv4Inspection.isTailnetIPv4("100.64.0.1"), "Tailscale lower IPv4 boundary rejected")
    check(TailscaleIPv4Inspection.isTailnetIPv4("100.127.255.254"), "Tailscale upper IPv4 boundary rejected")
    check(!TailscaleIPv4Inspection.isTailnetIPv4("100.128.0.1"), "non-tailnet CGNAT address accepted")
    check(!TailscaleIPv4Inspection.isTailnetIPv4("192.168.1.8"), "LAN address accepted as Tailscale")
    do {
        _ = try TailscaleIPv4Inspection.inspect(Data("192.168.1.8\n".utf8))
        failures.append("Tailscale IPv4 inspection accepted a LAN address")
    } catch CompanionHostAutomationError.invalidTailnetAddress {
        // Expected: QR discovery must never label a LAN address as Tailscale.
    }

    let empty = try TailscaleServeInspection.inspect(Data("{}".utf8), expectedProxy: TailscaleServeCoordinator.expectedProxy)
    check(empty == .unconfigured, "empty Tailscale Serve status must be treated as unconfigured")

    let readyData = Data(#"{"TCP":{"443":{"HTTPS":true}},"Web":{"macbook-air.tail532618.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:1051"}}}}}"#.utf8)
    let ready = try TailscaleServeInspection.inspect(
        readyData,
        expectedProxy: TailscaleServeCoordinator.expectedProxy
    )
    check(
        ready == .ready(origin: "https://macbook-air.tail532618.ts.net"),
        "matching Tailscale Serve status did not expose the stable HTTPS origin"
    )

    let trailingSlashData = Data(#"{"TCP":{"443":{"HTTPS":true}},"Web":{"macbook-air.tail532618.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:1051/"}}}}}"#.utf8)
    let trailingSlash = try TailscaleServeInspection.inspect(
        trailingSlashData,
        expectedProxy: TailscaleServeCoordinator.expectedProxy
    )
    check(
        trailingSlash == .ready(origin: "https://macbook-air.tail532618.ts.net"),
        "Tailscale Serve proxy normalization rejected a harmless trailing slash"
    )

    let conflictingData = Data(#"{"TCP":{"443":{"HTTPS":true}},"Web":{"macbook-air.tail532618.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:9999"}}}}}"#.utf8)
    let conflicting = try TailscaleServeInspection.inspect(
        conflictingData,
        expectedProxy: TailscaleServeCoordinator.expectedProxy
    )
    check(
        conflicting == .conflict,
        "conflicting Tailscale Serve target must never be overwritten"
    )

    let funnelData = Data(#"{"TCP":{"443":{"HTTPS":true}},"Web":{"macbook-air.tail532618.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:1051"}}}},"AllowFunnel":{"macbook-air.tail532618.ts.net:443":true}}"#.utf8)
    let funnel = try TailscaleServeInspection.inspect(
        funnelData,
        expectedProxy: TailscaleServeCoordinator.expectedProxy
    )
    check(
        funnel == .conflict,
        "Funnel configuration must never be adopted or overwritten"
    )
} catch {
    failures.append("Tailscale Serve inspection failed: \(error)")
}

do {
    let token = try CompanionHostTokenPolicy.validate(
        "WuMathNotes-2026",
        confirmation: "WuMathNotes-2026"
    )
    check(token == "WuMathNotes-2026", "custom Companion host token was not preserved exactly")
    check(CompanionHostTokenPolicy.generate().count == 64, "generated Companion host token length mismatch")
} catch {
    failures.append("valid custom Companion host token failed: \(error)")
}

do {
    _ = try CompanionHostTokenPolicy.validate("WuMathNotes-2026", confirmation: "WuMathNotes-2027")
    failures.append("mismatched Companion host token confirmation was accepted")
} catch CompanionHostAutomationError.tokenMismatch {
    // Expected.
} catch {
    failures.append("token mismatch returned unexpected error: \(error)")
}

do {
    _ = try CompanionHostTokenPolicy.normalize("too-short")
    failures.append("short Companion host token was accepted")
} catch CompanionHostAutomationError.invalidTokenLength {
    // Expected.
} catch {
    failures.append("short token returned unexpected error: \(error)")
}

do {
    _ = try CompanionHostTokenPolicy.normalize("Wu MathNotes 2026!")
    failures.append("unsafe Companion host token characters were accepted")
} catch CompanionHostAutomationError.invalidTokenCharacters {
    // Expected.
} catch {
    failures.append("unsafe token returned unexpected error: \(error)")
}

do {
    let data = Data(#"{"notebooks":[{"notebookId":"analysis","title":"泛函分析","sessionCount":1,"createdAt":"2026-07-23T00:00:00.000Z","updatedAt":"2026-07-23T01:00:00.000Z","sessions":[{"notebookId":"analysis","sessionId":"lecture","title":"第三讲","status":"draft","createdAt":"2026-07-23T00:00:00.000Z","updatedAt":"2026-07-23T01:00:00.000Z"}]}]}"#.utf8)
    let catalog = try JSONDecoder().decode(NotesCatalog.self, from: data)
    check(catalog.notebooks.count == 1, "catalog notebook count mismatch")
    check(catalog.notebooks[0].sessions.first?.title == "第三讲", "catalog session decode mismatch")
    check(CatalogSearch.filter(catalog.notebooks, query: "第三讲").first?.sessions.count == 1, "catalog session search mismatch")
    check(CatalogSearch.filter(catalog.notebooks, query: "不存在").isEmpty, "catalog empty search mismatch")
} catch {
    failures.append("catalog decode failed: \(error)")
}

do {
    let data = Data(#"{"version":1,"notebookId":"analysis","sessionId":"lecture","title":"第三讲","status":"draft","updatedAt":"2026-07-23T01:00:00.000Z","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","blocks":[{"id":"0001","order":0,"type":"markdown","source":"user","status":"draft","sourceName":"0001.md","renderInNote":true,"editable":true,"updatedAt":"2026-07-23T01:00:00.000Z"}]}"#.utf8)
    let manifest = try JSONDecoder().decode(ReadonlySessionManifest.self, from: data)
    check(manifest.blocks.first?.order == 0, "session manifest order mismatch")
    check(manifest.blocks.first?.renderInNote == true, "session manifest visibility mismatch")
    check(manifest.blocks.first?.editable == true, "session manifest editability mismatch")
} catch {
    failures.append("session manifest decode failed: \(error)")
}

do {
    let data = Data(#"{"version":1,"notebookId":"analysis","sessionId":"lecture","block":{"id":"0001","order":0,"type":"markdown","source":"user","status":"draft","sourceName":"0001.md","renderInNote":true,"editable":true,"updatedAt":"2026-07-23T01:00:00.000Z"},"content":{"kind":"markdown","html":"<p>正文</p>","markdown":"正文","baseRevision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","blockLocked":false,"protectedSpanCount":1}}"#.utf8)
    let payload = try JSONDecoder().decode(ReadonlySessionBlock.self, from: data)
    check(payload.content == .markdown(MarkdownBlockContent(
        html: "<p>正文</p>",
        markdown: "正文",
        baseRevision: String(repeating: "b", count: 64),
        blockLocked: false,
        protectedSpanCount: 1
    )), "markdown payload decode mismatch")
} catch {
    failures.append("session block decode failed: \(error)")
}

do {
    let data = Data(#"{"version":1,"imported":true,"blockId":"0002","manifest":{"version":1,"notebookId":"analysis","sessionId":"lecture","title":"第三讲","status":"draft","updatedAt":"2026-07-23T04:00:00.000Z","revision":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","blocks":[{"id":"0002","order":1,"type":"image","source":"user","status":"draft","sourceName":"board.png","renderInNote":true,"editable":false,"updatedAt":"2026-07-23T04:00:00.000Z"}]}}"#.utf8)
    let imported = try JSONDecoder().decode(ImportSessionImageResponse.self, from: data)
    check(imported.imported && imported.blockId == "0002", "image import response mismatch")
    check(imported.manifest.blocks.first?.type == "image", "image import manifest mismatch")
} catch {
    failures.append("image import response decode failed: \(error)")
}

do {
    let data = Data(#"{"version":1,"imported":true,"edited":true,"blockId":"0002","sourceAssetPath":"assets/photos/source.jpg","assetPath":"assets/embedded/edited.png","metadataPath":"assets/embedded/edited.annotation.json","sourceSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","outputSha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","manifest":{"version":1,"notebookId":"analysis","sessionId":"lecture","title":"第三讲","status":"draft","updatedAt":"2026-08-30T00:00:00.000Z","revision":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","blocks":[]}}"#.utf8)
    let edited = try JSONDecoder().decode(ImportSessionEditedImageResponse.self, from: data)
    check(edited.imported && edited.edited && edited.blockId == "0002", "edited image response mismatch")
    check(edited.metadataPath.hasSuffix(".annotation.json"), "edited image sidecar path mismatch")

    let metadata = MacImageEditMetadata(
        operations: [
            .crop(rect: MacNormalizedRect(x: 0.1, y: 0.2, width: 0.7, height: 0.6)),
            .rotate(quarterTurns: 1)
        ],
        annotations: [.arrow(
            id: "arrow-1",
            start: MacNormalizedPoint(x: 0.2, y: 0.2),
            end: MacNormalizedPoint(x: 0.8, y: 0.7),
            color: "#187857",
            width: 0.006
        )]
    )
    let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(metadata)) as? [String: Any]
    let operations = encoded?["operations"] as? [[String: Any]]
    check(operations?.map { $0["type"] as? String } == ["rotate", "crop"], "image operations were not contract ordered")
    let annotations = encoded?["annotations"] as? [[String: Any]]
    check(annotations?.first?["type"] as? String == "arrow", "image annotation encoding mismatch")
} catch {
    failures.append("edited image contract failed: \(error)")
}

do {
    let ready = SidecarReadyMessage(
        type: "mathnotes.ready",
        apiVersion: 1,
        instanceId: "image-edit-capture",
        host: "127.0.0.1",
        port: 43_123
    )
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CapturingURLProtocol.self]
    let client = LocalShellClient(session: URLSession(configuration: configuration))
    CapturingURLProtocol.requests = []
    CapturingURLProtocol.requestBodies = []
    CapturingURLProtocol.response = (200, #"{"version":1,"imported":true,"edited":true,"blockId":"0002","sourceAssetPath":"assets/photos/source.jpg","assetPath":"assets/embedded/edited.png","metadataPath":"assets/embedded/edited.annotation.json","sourceSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","outputSha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","manifest":{"version":1,"notebookId":"analysis","sessionId":"lecture","title":"第三讲","status":"draft","updatedAt":"2026-08-30T00:00:00.000Z","revision":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","blocks":[]}}"#)
    let outcome = waitFor {
        try await client.importSessionEditedImage(
            ready: ready,
            token: "local-token",
            notebookId: "analysis",
            sessionId: "lecture",
            fileName: "课堂黑板\r\nInjected: yes.jpg",
            sourceBytes: Data([0xff, 0xd8, 0xff, 0x01]),
            outputPngBytes: Data([0x89, 0x50, 0x4e, 0x47]),
            baseRevision: String(repeating: "b", count: 64),
            operations: [.rotate(quarterTurns: 1)],
            annotations: []
        )
    }
    guard case let .success(response) = outcome else {
        failures.append("edited image client request failed: \(outcome)")
        throw TestFailure()
    }
    check(response.edited, "edited image client lost response state")
    let request = CapturingURLProtocol.requests.last
    check(request?.url?.path == "/local/v1/session/image/edit", "edited image request path mismatch")
    check(request?.url?.query?.contains("notebookId=analysis") == true, "edited image notebook query missing")
    check(request?.value(forHTTPHeaderField: "Content-Type")?.contains("multipart/form-data; boundary=") == true, "edited image multipart content type missing")
    let body = String(decoding: CapturingURLProtocol.requestBodies.last ?? Data(), as: UTF8.self)
    check(body.contains("name=\"metadata\""), "edited image metadata field missing")
    check(body.contains("课堂黑板  Injected: yes.jpg"), "edited image UTF-8 file name missing")
    check(!body.contains("\r\nInjected: yes.jpg"), "edited image file name allowed multipart line injection")
    check(body.contains("name=\"source\""), "edited image source part missing")
    check(body.contains("name=\"output\""), "edited image output part missing")
} catch {
    failures.append("edited image multipart client contract failed: \(error)")
}

do {
    let data = Data(#"{"version":1,"task":{"version":1,"id":"recognition-1","notebookId":"analysis","sessionId":"lecture","imageBlockId":"0002","transcriptBlockId":"0003","status":"running","attempts":1,"providerName":"fixture","createdAt":"2026-07-24T00:00:00.000Z","updatedAt":"2026-07-24T00:00:01.000Z"}}"#.utf8)
    let response = try JSONDecoder().decode(SessionRecognitionTaskResponse.self, from: data)
    check(response.task.canCancel && !response.task.isTerminal, "running recognition task state mismatch")
    check(response.task.transcriptBlockId == "0003", "recognition transcript id mismatch")
} catch {
    failures.append("recognition task response decode failed: \(error)")
}

do {
    let data = Data(#"{"version":1,"activity":{"version":1,"notebookId":"analysis","sessionId":"lecture","captureId":"capture-1","fileName":"board.jpg","receivedBytes":512,"totalBytes":1024,"status":"receiving","updatedAt":"2026-07-29T00:00:00.000Z"}}"#.utf8)
    let response = try JSONDecoder().decode(SessionCompanionUploadActivityResponse.self, from: data)
    check(response.activity?.progress == 0.5, "companion upload progress mismatch")
    check(response.activity?.fileName == "board.jpg", "companion upload file name mismatch")
} catch {
    failures.append("companion upload activity decode failed: \(error)")
}

do {
    let task: [String: Any] = [
        "version": 1,
        "id": "recognition-1",
        "notebookId": "analysis",
        "sessionId": "lecture",
        "imageBlockId": "0002",
        "transcriptBlockId": "0003",
        "status": "running",
        "attempts": 1,
        "providerName": "fixture",
        "createdAt": "2026-07-24T00:00:00.000Z",
        "updatedAt": "2026-07-24T00:00:01.000Z"
    ]
    let eventPayload: [String: Any] = [
        "version": 1,
        "events": [[
            "version": 1,
            "sequence": 7,
            "taskId": "recognition-1",
            "type": "stdout",
            "message": "识别内容正在生成。",
            "delta": "## 草稿",
            "task": task
        ]]
    ]
    let data = try JSONSerialization.data(withJSONObject: eventPayload)
    let response = try JSONDecoder().decode(SessionRecognitionEventsResponse.self, from: data)
    check(response.events.first?.sequence == 7, "recognition event sequence mismatch")
    check(response.events.first?.delta == "## 草稿", "recognition event delta mismatch")
} catch {
    failures.append("recognition event response decode failed: \(error)")
}

do {
    let data = Data(#"{"version":1,"exported":true,"fileName":"lecture.md","relativeExportPath":"exports/lecture.md","exportedBlocks":3,"byteLength":128,"sha256":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}"#.utf8)
    let exported = try JSONDecoder().decode(SessionMarkdownExport.self, from: data)
    check(exported.exported && exported.fileName == "lecture.md", "session export response mismatch")
    check(exported.relativeExportPath == "exports/lecture.md", "session export leaked or lost its relative path")
} catch {
    failures.append("session export response decode failed: \(error)")
}

do {
    let data = Data(#"{"version":1,"configured":true,"providerId":"mimo_2_5","label":"Mimo v2.5","model":"mimo-v2.5","endpoint":"https://api.xiaomimimo.com/v1"}"#.utf8)
    let status = try JSONDecoder().decode(RuntimeProviderStatus.self, from: data)
    check(status.configured && status.providerId == "mimo_2_5", "provider status decode mismatch")
    check(status.label == "Mimo v2.5", "provider label decode mismatch")
} catch {
    failures.append("provider status decode failed: \(error)")
}

do {
    let data = Data(#"{"version":1,"id":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","blockId":"0001","baseRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","currentRevision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","incomingWriterId":"mac","reason":"diverged_edit","status":"unresolved","createdAt":"2026-07-24T00:00:00.000Z","currentMarkdown":"当前版本","incomingMarkdown":"离线来稿"}"#.utf8)
    let conflict = try JSONDecoder().decode(SessionMarkdownConflict.self, from: data)
    check(conflict.status == "unresolved", "conflict status decode mismatch")
    check(conflict.currentMarkdown == "当前版本" && conflict.incomingMarkdown == "离线来稿", "conflict sides decode mismatch")
} catch {
    failures.append("session conflict decode failed: \(error)")
}

do {
    let ready = SidecarReadyMessage(
        type: "mathnotes.ready",
        apiVersion: 1,
        instanceId: "purpose-capture",
        host: "127.0.0.1",
        port: 43_123
    )
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CapturingURLProtocol.self]
    let client = LocalShellClient(session: URLSession(configuration: configuration))

    CapturingURLProtocol.requests = []
    CapturingURLProtocol.response = (200, #"{"version":1,"configured":false,"purpose":"assistant","inherited":false}"#)
    let statusOutcome = waitFor {
        try await client.providerStatus(ready: ready, token: "local-token", purpose: .assistant)
    }
    guard case .success = statusOutcome else {
        failures.append("provider status request failed: \(statusOutcome)")
        throw TestFailure()
    }
    let statusURL = CapturingURLProtocol.requests.last?.url
    check(statusURL?.path == "/local/v1/provider", "provider status path mismatch")
    check(statusURL?.query?.contains("purpose=assistant") == true, "provider status purpose query missing")
    check(statusURL?.absoluteString.contains("%3F") == false, "provider purpose was percent-encoded into the path")

    CapturingURLProtocol.requests = []
    CapturingURLProtocol.response = (200, #"{"version":1,"configured":true,"purpose":"assistant","inherited":false}"#)
    let configureOutcome = waitFor {
        try await client.configureProvider(
            ready: ready,
            token: "local-token",
            providerId: "glm_5_2",
            model: "glm-5.2v",
            endpoint: "https://open.bigmodel.cn/api/paas/v4",
            apiKey: "dialogue-secret",
            purpose: .assistant
        )
    }
    guard case .success = configureOutcome else {
        failures.append("provider configure request failed: \(configureOutcome)")
        throw TestFailure()
    }
    let configureRequest = CapturingURLProtocol.requests.last
    check(configureRequest?.httpMethod == "POST", "provider configure method mismatch")
    check(configureRequest?.url?.query?.contains("purpose=assistant") == true, "provider configure purpose query missing")

    CapturingURLProtocol.requests = []
    CapturingURLProtocol.response = (200, #"{"version":1,"purpose":"assistant","ok":true,"message":"Provider 连通正常。"}"#)
    let probeOutcome = waitFor {
        try await client.testProvider(ready: ready, token: "local-token", purpose: .assistant)
    }
    guard case let .success(probe) = probeOutcome else {
        failures.append("provider connectivity test request failed: \(probeOutcome)")
        throw TestFailure()
    }
    check(probe.ok && probe.purpose == "assistant", "provider connectivity success decode mismatch")
    check(probe.message == "Provider 连通正常。", "provider connectivity success message mismatch")
    let probeRequest = CapturingURLProtocol.requests.last
    check(probeRequest?.url?.path == "/local/v1/provider/test", "provider connectivity path mismatch")
    check(probeRequest?.url?.query?.contains("purpose=assistant") == true, "provider connectivity purpose query missing")

    CapturingURLProtocol.response = (200, #"{"version":1,"purpose":"recognition","ok":false,"category":"authentication","message":"Provider 拒绝了请求：认证失败，请检查 API 密钥。"}"#)
    let failedProbe = waitFor { try await client.testProvider(ready: ready, token: "local-token") }
    guard case let .success(failed) = failedProbe else {
        failures.append("provider connectivity failure decode failed: \(failedProbe)")
        throw TestFailure()
    }
    check(failed.category == .authentication, "provider connectivity category decode mismatch")
    check(failed.message.contains("认证失败"), "provider connectivity sanitized message mismatch")

    CapturingURLProtocol.response = (503, #"{"error":"provider_unavailable"}"#)
    let rejectedProbe = waitFor { try await client.testProvider(ready: ready, token: "local-token", purpose: .assistant) }
    guard case let .failure(protocolError) = rejectedProbe,
          let providerRejection = protocolError as? SidecarProtocolError,
          case let .providerRejected(status, code, purpose) = providerRejection else {
        failures.append("unconfigured provider test did not surface providerRejected: \(rejectedProbe)")
        throw TestFailure()
    }
    check(status == 503 && code == "provider_unavailable" && purpose == .assistant, "unconfigured provider test rejection mismatch")
} catch {
    failures.append("provider purpose URL/client chain failed: \(error)")
}

do {
    let dialogueError = SidecarProtocolError.providerRejected(400, "invalid_provider_api_key", .assistant)
    check(dialogueError.localizedDescription.contains("对话模型"), "assistant provider error wording mismatch")
    check(!dialogueError.localizedDescription.contains("invalid_provider_api_key"), "provider error echoed its raw code")

    let recognitionError = SidecarProtocolError.providerRejected(400, "invalid_provider_model", .recognition)
    check(recognitionError.localizedDescription.contains("识别服务"), "recognition provider error wording mismatch")

    let secret = "fixture-credential-must-not-leak"
    let unknownError = SidecarProtocolError.providerRejected(500, secret, .assistant)
    check(!unknownError.localizedDescription.contains(secret), "provider error leaked unknown detail")
    check(unknownError.localizedDescription.contains("保存对话模型失败"), "unknown provider error lost purpose wording")
} catch {
    failures.append("provider error sanitization failed: \(error)")
}

do {
    let remoteStatus = RuntimeProviderStatus(
        version: 1,
        configured: true,
        providerId: ProviderPreset.glm.rawValue,
        label: "GLM 5.2",
        model: "glm-5.2v",
        endpoint: "https://open.bigmodel.cn/api/paas/v4",
        purpose: "assistant",
        inherited: false
    )

    let unconfigured = ProviderRestoration.resolve(
        hasSavedRecord: false,
        savedKeyAvailable: false,
        remoteStatus: .unconfigured,
        restoreFailureMessage: nil
    )
    check(unconfigured.error == nil && !unconfigured.status.configured, "unconfigured restoration must not invent an error")

    let missingKey = ProviderRestoration.resolve(
        hasSavedRecord: true,
        savedKeyAvailable: false,
        remoteStatus: .unconfigured,
        restoreFailureMessage: nil
    )
    check(missingKey.error == .missingCredential, "missing key restoration error mismatch")
    check(!missingKey.status.configured, "missing key restoration status mismatch")

    let rejected = ProviderRestoration.resolve(
        hasSavedRecord: true,
        savedKeyAvailable: true,
        remoteStatus: .unconfigured,
        restoreFailureMessage: "保存对话模型失败（HTTP 400），请稍后重试。"
    )
    check(rejected.error == .rejected(sanitizedMessage: "保存对话模型失败（HTTP 400），请稍后重试。"), "rejected restoration error mismatch")
    check(!rejected.status.configured, "rejected restoration status mismatch")

    let restored = ProviderRestoration.resolve(
        hasSavedRecord: true,
        savedKeyAvailable: true,
        remoteStatus: remoteStatus,
        restoreFailureMessage: nil
    )
    check(restored.status == remoteStatus && restored.error == nil, "successful restoration state mismatch")

    let recognitionState = ProviderRestoration.resolve(
        hasSavedRecord: false,
        savedKeyAvailable: false,
        remoteStatus: .unconfigured,
        restoreFailureMessage: nil
    )
    check(recognitionState.error == nil, "recognition restoration error leaked into assistant state")
} catch {
    failures.append("provider restoration state failed: \(error)")
}

if failures.isEmpty {
    print("MACOS_NATIVE_CONTRACT_OK checks=\(checks)")
} else {
    for failure in failures { FileHandle.standardError.write(Data("FAIL: \(failure)\n".utf8)) }
    exit(1)
}

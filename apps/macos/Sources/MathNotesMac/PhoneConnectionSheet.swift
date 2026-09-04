import AppKit
import SwiftUI

private enum PhoneConnectionRoute: String, Hashable {
    case tailnet
    case local

    var title: String {
        switch self {
        case .tailnet: "Tailscale"
        case .local: "局域网"
        }
    }

    var detail: String {
        switch self {
        case .tailnet: "远程连接"
        case .local: "同一网络"
        }
    }

    var icon: String {
        switch self {
        case .tailnet: "network"
        case .local: "wifi"
        }
    }

    var transport: CompanionPairingTransport {
        switch self {
        case .tailnet: .tailnetHTTP
        case .local: .privateHTTP
        }
    }
}

private struct PhoneConnectionEndpoint: Equatable {
    let route: PhoneConnectionRoute
    let address: String

    func origin(port: Int) -> String {
        "http://\(address):\(port)"
    }
}

struct PhoneConnectionSheet: View {
    @ObservedObject var supervisor: SidecarSupervisor
    let onOpenSettings: () -> Void

    @Environment(\.dismiss) private var dismiss
    @StateObject private var lanAddressMonitor = CompanionLanAddressMonitor()
    @State private var isRefreshingPairing = false
    @State private var isRefreshingAddresses = false
    @State private var tailnetAddress: String?
    @State private var selectedRoute: PhoneConnectionRoute?
    @State private var networkMessage: String?
    @State private var statusMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            header

            Divider()

            ScrollView {
                connectionContent
                    .frame(maxWidth: .infinity)
                    .padding(MathNotesTheme.Spacing.page)
            }

            Divider()

            HStack {
                Button("更多连接设置") {
                    ProviderSettingsSection.select(.companion)
                    dismiss()
                    onOpenSettings()
                }
                .buttonStyle(.borderless)

                Spacer()

                Button("完成") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, MathNotesTheme.Spacing.page)
            .padding(.vertical, MathNotesTheme.Spacing.standard)
        }
        .frame(width: 640, height: 610)
        .background(MathNotesTheme.canvas)
        .accessibilityIdentifier("phone-connection-sheet")
        .task {
            supervisor.startIfNeeded()
            await refreshConnectionAddresses()
            await ensurePairingChallenge()
        }
        .task(id: supervisor.companionHost?.port) {
            await ensurePairingChallenge()
        }
    }

    private var header: some View {
        HStack(spacing: MathNotesTheme.Spacing.standard) {
            Image(systemName: "qrcode")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(MathNotesTheme.accent)
                .frame(width: 42, height: 42)
                .background(MathNotesTheme.accentSoft, in: RoundedRectangle(cornerRadius: 13, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                Text("连接手机")
                    .font(.title2.weight(.semibold))
                Text("在 Android 上打开 MathNotes，扫描这里的二维码")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.body.weight(.semibold))
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("关闭连接手机")
        }
        .padding(.horizontal, MathNotesTheme.Spacing.page)
        .padding(.vertical, MathNotesTheme.Spacing.section)
    }

    private var availableEndpoints: [PhoneConnectionEndpoint] {
        var endpoints: [PhoneConnectionEndpoint] = []
        if let tailnetAddress {
            endpoints.append(PhoneConnectionEndpoint(route: .tailnet, address: tailnetAddress))
        }
        if let address = lanAddressMonitor.recommended?.address {
            endpoints.append(PhoneConnectionEndpoint(route: .local, address: address))
        }
        return endpoints
    }

    private var activeEndpoint: PhoneConnectionEndpoint? {
        if let selectedRoute,
           let selected = availableEndpoints.first(where: { $0.route == selectedRoute }) {
            return selected
        }
        return availableEndpoints.first
    }

    private var allPairingAddresses: [String] {
        let candidates = [tailnetAddress].compactMap { $0 } + lanAddressMonitor.addresses.map(\.address)
        var seen = Set<String>()
        return candidates.filter { seen.insert($0).inserted }
    }

    @ViewBuilder
    private var connectionContent: some View {
        if supervisor.companionHost == nil {
            switch supervisor.state {
            case let .failed(message):
                connectionFailureState(message)
            case .ready:
                connectionFailureState("本机服务已经启动，但手机连接端口没有就绪。请重试；若仍失败，请打开更多连接设置查看状态。")
            case .idle, .starting, .stopping:
                connectionWaitingState
            }
        } else if let endpoint = activeEndpoint,
                  let host = supervisor.companionHost {
            if let challenge = supervisor.companionPairingChallenge {
                pairingReadyState(challenge: challenge, endpoint: endpoint, host: host)
            } else {
                pairingGenerationState
            }
        } else if isRefreshingAddresses {
            networkDiscoveryState
        } else {
            missingNetworkState
        }
    }

    private var connectionWaitingState: some View {
        VStack(spacing: MathNotesTheme.Spacing.section) {
            ProgressView()
                .controlSize(.large)
            Text("正在准备手机连接")
                .font(.title3.weight(.semibold))
            Text("MathNotes 正在启动本机连接服务，准备好后会自动显示二维码。")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 390)
        .accessibilityIdentifier("phone-connection-waiting")
    }

    private var networkDiscoveryState: some View {
        VStack(spacing: MathNotesTheme.Spacing.section) {
            ProgressView()
                .controlSize(.large)
            Text("正在检测连接网络")
                .font(.title3.weight(.semibold))
            Text("正在检查同一 Wi-Fi、手机热点和已有的 Tailscale 连接。")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 390)
        .accessibilityIdentifier("phone-connection-network-discovery")
    }

    private func connectionFailureState(_ message: String) -> some View {
        VStack(spacing: MathNotesTheme.Spacing.section) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 48, weight: .light))
                .foregroundStyle(MathNotesTheme.warning)
            Text("手机连接还没有准备好")
                .font(.title3.weight(.semibold))
            Text(message)
                .frame(maxWidth: 420)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            Button("重试") {
                statusMessage = nil
                supervisor.start()
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, minHeight: 390)
        .accessibilityIdentifier("phone-connection-failed")
    }

    private var pairingGenerationState: some View {
        VStack(spacing: MathNotesTheme.Spacing.section) {
            if isRefreshingPairing { ProgressView().controlSize(.large) }
            Image(systemName: "qrcode")
                .font(.system(size: 48, weight: .light))
                .foregroundStyle(.secondary)
            Text(isRefreshingPairing ? "正在生成二维码" : "二维码还没有生成")
                .font(.title3.weight(.semibold))
            if let statusMessage {
                Text(statusMessage)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(MathNotesTheme.failure)
            }
            Button("生成二维码") {
                Task { await ensurePairingChallenge(force: true) }
            }
            .buttonStyle(.borderedProminent)
            .disabled(isRefreshingPairing)
        }
        .frame(maxWidth: .infinity, minHeight: 390)
        .accessibilityIdentifier("phone-connection-generation")
    }

    private var missingNetworkState: some View {
        VStack(spacing: MathNotesTheme.Spacing.section) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 50, weight: .light))
                .foregroundStyle(MathNotesTheme.warning)
            Text("还没有可用的连接网络")
                .font(.title3.weight(.semibold))
            Text(networkMessage ?? "请让 Mac 与手机连接同一个 Wi-Fi、手机热点或同一 Tailscale 网络。检测到地址后，二维码会自动出现。")
                .frame(maxWidth: 390)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button("重新检测") {
                Task {
                    await refreshConnectionAddresses()
                    await ensurePairingChallenge(force: true)
                }
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, minHeight: 390)
        .accessibilityIdentifier("phone-connection-no-network")
    }

    private func pairingReadyState(
        challenge: CompanionPairingChallenge,
        endpoint: PhoneConnectionEndpoint,
        host: SidecarCompanionHost
    ) -> some View {
        let payload = challenge.pairingLink(
            host: endpoint.address,
            port: host.port,
            alternateHosts: allPairingAddresses,
            transport: endpoint.route.transport
        )

        return VStack(spacing: MathNotesTheme.Spacing.section) {
            if availableEndpoints.count > 1 {
                Picker(
                    "连接方式",
                    selection: Binding(
                        get: { activeEndpoint?.route ?? endpoint.route },
                        set: { selectedRoute = $0 }
                    )
                ) {
                    ForEach(availableEndpoints, id: \.route) { candidate in
                        Text("\(candidate.route.title) · \(candidate.route.detail)")
                            .tag(candidate.route)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("phone-connection-route-picker")
            }

            HStack(alignment: .center, spacing: MathNotesTheme.Spacing.page) {
                Group {
                    if let qrCode = CompanionPairingQRCode.image(payload: payload, side: 224) {
                        Image(nsImage: qrCode)
                            .interpolation(.none)
                            .resizable()
                            .accessibilityLabel("连接手机二维码")
                    } else {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 44, weight: .light))
                            .foregroundStyle(MathNotesTheme.failure)
                            .accessibilityLabel("二维码生成失败")
                    }
                }
                .frame(width: 224, height: 224)
                .padding(14)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .strokeBorder(MathNotesTheme.separator.opacity(0.45))
                }
                .accessibilityIdentifier("phone-pairing-qr")

                VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.standard) {
                    Label("可以扫码连接", systemImage: "checkmark.circle.fill")
                        .font(.headline)
                        .foregroundStyle(MathNotesTheme.accent)

                    VStack(alignment: .leading, spacing: 4) {
                        Text("一次性配对码")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(challenge.userCode)
                            .font(.system(.title, design: .monospaced, weight: .semibold))
                            .textSelection(.enabled)
                    }

                    Text("二维码十分钟内有效，成功连接一次后立即失效。")
                        .font(.callout)
                        .foregroundStyle(.secondary)

                    HStack {
                        Button("刷新二维码") {
                            Task { await ensurePairingChallenge(force: true) }
                        }
                        .disabled(isRefreshingPairing)

                        Button("复制连接链接") {
                            copy(payload)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            HStack(spacing: MathNotesTheme.Spacing.standard) {
                Image(systemName: endpoint.route.icon)
                    .foregroundStyle(MathNotesTheme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text(
                        endpoint.route == .tailnet
                            ? "通过 Tailscale 连接"
                            : "手机与 Mac 使用同一网络"
                    )
                        .font(.callout.weight(.medium))
                    Text(endpoint.origin(port: host.port))
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                Spacer()
                Button("复制地址") { copy(endpoint.origin(port: host.port)) }
                    .buttonStyle(.borderless)
            }
            .padding(MathNotesTheme.Spacing.standard)
            .background(MathNotesTheme.accentSoft, in: RoundedRectangle(cornerRadius: 14, style: .continuous))

            Text(statusMessage ?? (
                endpoint.route == .tailnet
                    ? "手机也需登录同一 Tailscale 网络；二维码只包含一次性配对信息。"
                    : "二维码只包含一次性配对信息，不包含你的长期连接令牌。"
            ))
                .font(.caption)
                .foregroundStyle(
                    statusMessage == nil ? Color(nsColor: .secondaryLabelColor) : MathNotesTheme.accent
                )
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("phone-connection-ready")
    }

    private func refreshConnectionAddresses() async {
        lanAddressMonitor.refresh()
        isRefreshingAddresses = true
        networkMessage = nil
        defer { isRefreshingAddresses = false }

        do {
            let coordinator = try TailscaleServeCoordinator.locate()
            tailnetAddress = try await coordinator.readIPv4Address()
        } catch CompanionHostAutomationError.tailscaleMissing {
            tailnetAddress = nil
            if lanAddressMonitor.recommended == nil {
                networkMessage = "未检测到 Tailscale。请让两台设备加入同一 Wi-Fi、手机热点，或先在 Mac 上安装并登录 Tailscale。"
            }
        } catch {
            tailnetAddress = nil
            if lanAddressMonitor.recommended == nil {
                networkMessage = "未检测到可用网络。请让两台设备加入同一 Wi-Fi、手机热点，或确认两端已经登录同一个 Tailscale 网络。"
            }
        }
    }

    private func ensurePairingChallenge(force: Bool = false) async {
        guard supervisor.companionHost != nil else { return }
        if !force,
           let challenge = supervisor.companionPairingChallenge,
           let expiry = ISO8601DateFormatter().date(from: challenge.expiresAt),
           expiry.timeIntervalSinceNow > 30 {
            return
        }

        isRefreshingPairing = true
        statusMessage = nil
        defer { isRefreshingPairing = false }
        do {
            _ = try await supervisor.createCompanionPairingChallenge()
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    private func copy(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
        statusMessage = "已复制"
    }
}

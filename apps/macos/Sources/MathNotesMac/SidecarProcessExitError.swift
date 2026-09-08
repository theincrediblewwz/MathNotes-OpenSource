import Foundation

struct SidecarProcessExitError: LocalizedError {
    let status: Int32
    let wasSignal: Bool

    init(process: Process) {
        status = process.terminationStatus
        wasSignal = process.terminationReason == .uncaughtSignal
    }

    var errorDescription: String? {
        let detail = wasSignal ? "信号 \(status)" : "退出码 \(status)"
        let action = wasSignal && status == 9
            ? "请查看 macOS 诊断报告中的终止原因；若为 CODESIGNING，请重新安装修复后的应用。"
            : "请重试，并查看本次启动的后台日志。"
        return "本机连接服务已退出（\(detail)）。\(action)"
    }
}

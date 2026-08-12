import type { IngestServerState } from "../types/mathNotesApi";

export type DiagnosticStatus = "ok" | "attention";

export type ConnectionDiagnosticCheck = {
  id: string;
  label: string;
  status: DiagnosticStatus;
  detail: string;
};

export type ConnectionDiagnosticReport = {
  summary: "ready" | "attention";
  recommendedMode: "tailscale_first";
  checks: ConnectionDiagnosticCheck[];
  guidance: string[];
};

export type BuildConnectionDiagnosticsArgs = {
  hasNativeApi: boolean;
  ingestServer: IngestServerState;
};

export function buildConnectionDiagnostics(args: BuildConnectionDiagnosticsArgs): ConnectionDiagnosticReport {
  const hasReachableAddress = Boolean(
    args.ingestServer.addressCandidates?.some((candidate) => !candidate.internal && candidate.usable !== false)
  );
  const checks: ConnectionDiagnosticCheck[] = [
    {
      id: "electron",
      label: "Electron",
      status: args.hasNativeApi ? "ok" : "attention",
      detail: args.hasNativeApi ? "桌面 API 已连接" : "当前是浏览器预览，不能接收 Android 上传"
    },
    {
      id: "ingest-server",
      label: "接收服务",
      status: args.ingestServer.running ? "ok" : "attention",
      detail: args.ingestServer.running ? `运行中：${args.ingestServer.url ?? "等待地址"}` : "未启动"
    },
    {
      id: "pairing",
      label: "配对令牌",
      status: args.ingestServer.token && args.ingestServer.pairingPayload ? "ok" : "attention",
      detail: args.ingestServer.token && args.ingestServer.pairingPayload ? "二维码与 token 已生成" : "启动接收后生成二维码和 token"
    },
    {
      id: "address",
      label: "可访问地址",
      status: hasReachableAddress ? "ok" : "attention",
      detail: hasReachableAddress ? "检测到手机可选的私有 IPv4 地址" : "当前只有 loopback、VPN 或虚拟网卡地址"
    }
  ];

  return {
    summary: checks.every((check) => check.status === "ok") ? "ready" : "attention",
    recommendedMode: "tailscale_first",
    checks,
    guidance: [
      "默认优先使用 Tailscale；手机与电脑需要加入同一 Tailnet。",
      "Tailscale 不可用时，可回退到 Windows 热点、USB 网络或可信局域网。",
      "公共 Wi-Fi 可能启用 client isolation；同一 SSID 不代表设备可以互访。"
    ]
  };
}

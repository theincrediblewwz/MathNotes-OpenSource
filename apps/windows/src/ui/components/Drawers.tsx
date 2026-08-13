import { Archive, Download, FileCheck2, FolderOpen, Plus, Settings, X } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { PROVIDER_CATALOG, type ProviderDescriptor } from "@mathnotes/shared";
import type {
  ConnectionDiagnosticReport,
  IngestServerState,
  NotebookSessionSummary,
  NotebookSummary,
  NotationPreviewInput,
  NotationProfileConfig,
  NotationPromptPreview,
  ExportUserDiagnosticReportResult,
  PickImageForAnnotationResult,
  PromptTemplateConfig,
  ProviderSelfTestResult,
  ProviderHealthReport,
  AssistantProviderConfig,
  AssistantProviderConfigInput,
  RecognitionProviderConfig,
  RecognitionProviderConfigInput,
  UpdatePairingTokenInput,
  UserSettings
} from "../../types/mathNotesApi";
import { defaultAssistantFontFamily, defaultPreviewFontFamily, defaultSourceFontFamily } from "../../common/defaultUserSettings";
import { defaultLocaleId, defaultThemeId, localeOptions, themeOptions } from "../../common/appearanceSettings";
import { DEFAULT_PREVIEW_FOLLOW_SHORTCUT, normalizeKeyboardShortcutFromEvent } from "../../common/keyboardShortcuts";
import { defaultMathPromptTemplate, type PromptTemplate } from "../../common/promptTemplates";
import { createEmptyNotationProfileConfig, type NotationProfile, type NotationRule } from "../../common/notationProfiles";
import { getRecognitionProviderCapability } from "../providerCapabilities";

type DrawerProps = {
  openLayer: string | null;
  onClose: () => void;
};

type DirectoryPicker = (args: { currentPath: string; title: string }) => Promise<string | undefined>;

const contextMenuWidth = 154;
const fontOptions = [
  { label: "Cascadia Mono", value: defaultSourceFontFamily },
  { label: "Consolas", value: 'Consolas, "SFMono-Regular", monospace' },
  { label: "JetBrains Mono", value: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace' },
  { label: "VSCode Preview", value: defaultPreviewFontFamily },
  { label: "Inter / Noto Sans SC", value: '"Inter", "Noto Sans SC", system-ui, sans-serif' },
  { label: "Segoe UI / Microsoft YaHei", value: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif' },
  { label: "Serif Math", value: '"STIX Two Text", "Times New Roman", "Noto Serif SC", serif' }
];

type NotebookDrawerProps = DrawerProps & {
  notebookId?: string;
  notebookTitle?: string;
  sessionTitle?: string;
  sessionId?: string;
  sessions?: NotebookSessionSummary[];
  notebooks?: NotebookSummary[];
  onCreateNotebook?: () => void;
  onCreateSession?: () => void;
  onDeleteSession?: (session: NotebookSessionSummary) => void;
  onOpenSession?: (session: NotebookSessionSummary) => void;
  onOpenNotebook?: (notebook: NotebookSummary) => void;
  onRenameSession?: (session: NotebookSessionSummary) => void;
  onOpenSettings?: () => void;
};

export function NotebookDrawer({
  openLayer,
  onClose,
  notebookId = "functional_analysis",
  notebookTitle = "数学笔记",
  sessionTitle = "当前 Session",
  sessionId = "",
  sessions = [],
  notebooks = [],
  onCreateNotebook,
  onCreateSession,
  onDeleteSession,
  onOpenSession,
  onOpenNotebook,
  onRenameSession,
  onOpenSettings
}: NotebookDrawerProps) {
  const [contextMenu, setContextMenu] = useState<{ session: NotebookSessionSummary; x: number; y: number } | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (openLayer !== "notebook") {
      setContextMenu(null);
    }
  }, [openLayer]);
  const visibleSessions =
    sessions.length > 0
      ? sessions
      : [
          {
            notebookId: notebookTitle,
            sessionId,
            title: sessionTitle,
            status: "draft" as const,
            createdAt: "",
            updatedAt: ""
          }
        ];

  return (
    <aside
      aria-label="笔记目录"
      className={`drawer left-drawer ${openLayer === "notebook" ? "open" : ""}`}
      data-testid={openLayer === "notebook" ? "notebook-drawer" : undefined}
      ref={drawerRef}
    >
      <div className="drawer-head">
        <div>
          <span className="eyebrow">Notebook</span>
          <h2>{notebookTitle}</h2>
        </div>
        <button aria-label="关闭笔记目录" className="plain-icon" onClick={onClose} type="button">
          <X />
        </button>
      </div>
      <button className="drawer-action" onClick={onCreateNotebook} type="button">
        <Plus /> 新建 Notebook
      </button>
      <button className="drawer-secondary-action" onClick={onCreateSession} type="button">
        <Plus /> 新建 Session
      </button>
      <button className="drawer-secondary-action" onClick={onOpenSettings} type="button">
        <Settings /> 设置
      </button>
      <div className="drawer-section">
        <h3>Notebooks</h3>
        {notebooks.map((notebook) => (
          <button
            className={`notebook-row ${notebook.notebookId === notebookId ? "active" : ""}`}
            key={notebook.notebookId}
            onClick={() => onOpenNotebook?.(notebook)}
            type="button"
          >
            <FolderOpen />
            <span>
              <strong>{notebook.title}</strong>
              <small>{notebook.sessionCount} 个 Session</small>
            </span>
          </button>
        ))}
      </div>
      <div className="drawer-section">
        <h3>当前 Notebook 的 Sessions</h3>
        {visibleSessions.map((session) => (
          <button
            className={`session-row ${session.sessionId === sessionId ? "active" : ""}`}
            key={session.sessionId}
            onClick={() => onOpenSession?.(session)}
            onContextMenu={(event) => {
              event.preventDefault();
              const drawerRect = drawerRef.current?.getBoundingClientRect();
              const localX = drawerRect ? event.clientX - drawerRect.left : event.clientX;
              const localY = drawerRect ? event.clientY - drawerRect.top : event.clientY;
              const maxX = drawerRect ? drawerRect.width - contextMenuWidth - 8 : window.innerWidth - contextMenuWidth - 8;
              const maxY = drawerRect ? drawerRect.height - 48 : window.innerHeight - 48;
              setContextMenu({
                session,
                x: Math.max(8, Math.min(localX, maxX)),
                y: Math.max(8, Math.min(localY, maxY))
              });
            }}
            title="右键管理 Session"
            type="button"
          >
            <span>{session.title || "未命名"}</span>
            <small>{session.sessionId || "draft"}</small>
          </button>
        ))}
      </div>
      {contextMenu ? (
        <div className="drawer-context-menu" data-testid="session-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button
            onClick={() => {
              onRenameSession?.(contextMenu.session);
              setContextMenu(null);
            }}
            role="menuitem"
            type="button"
          >
            重命名 Session
          </button>
          <button
            className="danger-menuitem"
            onClick={() => {
              onDeleteSession?.(contextMenu.session);
              setContextMenu(null);
            }}
            role="menuitem"
            type="button"
          >
            删除 Session
          </button>
        </div>
      ) : null}
    </aside>
  );
}

type MoreDrawerProps = DrawerProps & {
  ingestServer?: IngestServerState;
  connectionDiagnostics?: ConnectionDiagnosticReport | null;
  hasNativeApi?: boolean;
  onStartIngest?: () => void;
  onRefreshIngestAddresses?: () => void;
  onRefreshDevicePairing?: () => void;
  onRevokePairedDevice?: (deviceId: string) => void;
  onSelectIngestHost?: (host: string | null) => void;
  onCopyConnectionValue?: (value: string) => void;
  onCopyPairingToken?: (token: string) => void;
  onStopIngest?: () => void;
  onReloadSession?: () => void;
  onImportLocalPhoto?: () => void;
};

function ConnectionTutorialValue({
  displayValue,
  label,
  unavailable,
  value,
  onCopy
}: {
  displayValue?: string;
  label: string;
  unavailable: string;
  value?: string;
  onCopy?: (value: string) => void;
}) {
  return (
    <div className="connection-tutorial-value">
      <span>{label}</span>
      <code>{displayValue ?? value ?? unavailable}</code>
      <button
        aria-label={`复制${label}`}
        className="inline-action"
        disabled={!value}
        onClick={() => {
          if (value) onCopy?.(value);
        }}
        type="button"
      >
        复制
      </button>
    </div>
  );
}

export function MoreDrawer({
  openLayer,
  onClose,
  ingestServer = { running: false },
  connectionDiagnostics = null,
  hasNativeApi = false,
  onStartIngest,
  onRefreshIngestAddresses,
  onRefreshDevicePairing,
  onRevokePairedDevice,
  onSelectIngestHost,
  onCopyConnectionValue,
  onCopyPairingToken,
  onStopIngest
}: MoreDrawerProps) {
  const [pendingRevokeDeviceId, setPendingRevokeDeviceId] = useState<string | null>(null);
  const [revealsPairingToken, setRevealsPairingToken] = useState(false);
  const usableCandidates = ingestServer.addressCandidates?.filter((candidate) => candidate.usable !== false) ?? [];
  const lanCandidate = usableCandidates.find((candidate) => candidate.transportKind === "private_lan");
  const tailnetCandidate = usableCandidates.find((candidate) => candidate.transportKind === "tailnet");
  const connectionUrl = (address?: string) => {
    if (!address || !ingestServer.port) return undefined;
    const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
    return `http://${host}:${ingestServer.port}`;
  };
  const lanUrl = connectionUrl(lanCandidate?.address);
  const tailnetUrl = connectionUrl(tailnetCandidate?.address);

  return (
    <aside
      aria-label="手机连接"
      className={`drawer right-drawer ${openLayer === "more" ? "open" : ""}`}
      data-testid={openLayer === "more" ? "more-drawer" : undefined}
    >
      <div className="drawer-head">
        <div>
          <h2>手机连接</h2>
        </div>
        <button aria-label="关闭手机连接" className="plain-icon" onClick={onClose} type="button">
          <X />
        </button>
      </div>
      <section>
        <div className="connection-panel" data-testid="connection-panel">
          <PairingQr payload={ingestServer.devicePairingPayload ?? ingestServer.pairingPayload} />
          <p className="connection-guidance">
            Android App 或 iPhone PWA 都可连接；同一 Wi-Fi、iPhone 热点和 Tailscale 只是不同的传输路径。
          </p>
          <details className="connection-tutorial">
            <summary>第一次连接手机</summary>
            <div className="connection-tutorial-section">
              <strong>iPhone / PWA</strong>
              <ol>
                <li>让电脑与 iPhone 加入同一 Wi-Fi；也可以让电脑连接 iPhone 热点。</li>
                <li>在 Safari 打开下方局域网地址，输入配对令牌。</li>
                <li>连接成功后可用 Safari 的“添加到主屏幕”安装 PWA。</li>
              </ol>
              <ConnectionTutorialValue
                label="局域网 / 热点地址"
                unavailable="未发现；请先接入同一 Wi-Fi 或手机热点，再刷新网络地址"
                value={lanUrl}
                onCopy={onCopyConnectionValue}
              />
              <ConnectionTutorialValue
                displayValue={ingestServer.running && ingestServer.token
                  ? revealsPairingToken ? ingestServer.token : "••••••••••••••••••••"
                  : undefined}
                label="PWA / 手填配对令牌"
                unavailable="启动接收后生成"
                value={ingestServer.running ? ingestServer.token : undefined}
                onCopy={onCopyPairingToken}
              />
            </div>
            <div className="connection-tutorial-section">
              <strong>Tailscale（高级 / 远程）</strong>
              <p>两台设备已加入同一 tailnet 时，可打开下方网络地址。这里不会自动配置 Tailscale，也不会把 IP 地址冒充 HTTPS 域名。</p>
              <ConnectionTutorialValue
                label="Tailscale 网络地址"
                unavailable="未发现 Tailscale 地址"
                value={tailnetUrl}
                onCopy={onCopyConnectionValue}
              />
              <small>如果你已自行配置 Tailscale Serve，请继续使用已有的 HTTPS 地址；MathNotes 当前不会读取或改动该配置。</small>
            </div>
            <div className="connection-tutorial-section">
              <strong>Android App</strong>
              <p>同一 Wi-Fi、手机热点或 Tailscale 均可。优先扫描上方二维码：二维码和短配对码约 10 分钟有效且只用一次；无法扫码时再手填电脑地址与长期配对令牌。</p>
            </div>
          </details>
          <dl className="connection-facts">
            <div>
              <dt>手机连接地址</dt>
              <dd>{ingestServer.running ? ingestServer.url : "未启动"}</dd>
            </div>
            <div>
              <dt>地址策略</dt>
              <dd>{ingestServer.preferredHost
                ? ingestServer.preferredHost === ingestServer.displayHost
                  ? `已固定 ${ingestServer.preferredHost}`
                  : `固定地址暂不可用，已回退到 ${ingestServer.displayHost ?? "自动入口"}`
                : "自动选择 · Tailscale 优先"}</dd>
            </div>
            <div>
              <dt>新设备配对码</dt>
              <dd className="pairing-token-row">
                <code>{ingestServer.running ? ingestServer.devicePairingCode ?? "正在生成" : "启动接收后生成"}</code>
                <button
                  className="inline-action"
                  disabled={!ingestServer.running}
                  onClick={onRefreshDevicePairing}
                  type="button"
                >
                  刷新二维码
                </button>
              </dd>
            </div>
            <div>
              <dt>配对令牌</dt>
              <dd className="pairing-token-row">
                <code data-testid="pairing-token">{ingestServer.running && ingestServer.token
                  ? revealsPairingToken ? ingestServer.token : "••••••••••••••••••••"
                  : "启动接收后生成"}</code>
                <button
                  aria-label={revealsPairingToken ? "隐藏配对令牌" : "显示配对令牌"}
                  className="inline-action"
                  disabled={!ingestServer.running || !ingestServer.token}
                  onClick={() => setRevealsPairingToken((current) => !current)}
                  type="button"
                >
                  {revealsPairingToken ? "隐藏" : "显示"}
                </button>
                <button
                  aria-label="复制配对令牌"
                  className="inline-action"
                  disabled={!ingestServer.running || !ingestServer.token}
                  onClick={() => {
                    if (ingestServer.token) onCopyPairingToken?.(ingestServer.token);
                  }}
                  type="button"
                >
                  复制
                </button>
              </dd>
            </div>
          </dl>
          {ingestServer.pairedDevices?.length ? (
            <div className="paired-device-list">
              <strong>已配对设备</strong>
              {ingestServer.pairedDevices.map((device) => (
                <div className="paired-device-row" key={device.deviceId}>
                  <span>
                    <strong>{device.label}</strong>
                    <small>{device.lastSeenAt ? `最近连接 ${new Date(device.lastSeenAt).toLocaleString()}` : "尚未使用"}</small>
                  </span>
                  <button
                    className="inline-action danger-text"
                    onClick={() => setPendingRevokeDeviceId(device.deviceId)}
                    type="button"
                  >
                    撤销
                  </button>
                  {pendingRevokeDeviceId === device.deviceId ? (
                    <span className="paired-device-confirm">
                      <button
                        className="inline-action danger-text"
                        onClick={() => {
                          onRevokePairedDevice?.(device.deviceId);
                          setPendingRevokeDeviceId(null);
                        }}
                        type="button"
                      >确认撤销</button>
                      <button className="inline-action" onClick={() => setPendingRevokeDeviceId(null)} type="button">取消</button>
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {ingestServer.addressCandidates?.length ? (
            <div className="address-list">
              <div className="address-list-head">
                <span>网络地址</span>
                <button
                  className="inline-action"
                  disabled={!ingestServer.running}
                  onClick={onRefreshIngestAddresses}
                  type="button"
                >
                  刷新
                </button>
              </div>
              <button
                aria-pressed={!ingestServer.preferredHost}
                className={`address-candidate ${!ingestServer.preferredHost ? "selected" : ""}`}
                disabled={!ingestServer.running}
                onClick={() => onSelectIngestHost?.(null)}
                type="button"
              >
                <span><strong>自动选择</strong><code>Tailscale 优先</code></span>
                <small>{!ingestServer.preferredHost ? "当前模式" : "恢复自动"}</small>
              </button>
              {usableCandidates.map((candidate) => {
                const selected = candidate.address === ingestServer.displayHost;
                const fixed = candidate.address === ingestServer.preferredHost;
                return (
                  <button
                    aria-pressed={selected}
                    className={`address-candidate ${selected ? "selected" : ""}`}
                    disabled={!ingestServer.running || candidate.usable === false}
                    key={`${candidate.label}:${candidate.address}`}
                    onClick={() => onSelectIngestHost?.(candidate.address)}
                    type="button"
                  >
                    <span><strong>{candidate.label}</strong><code>{candidate.address}</code></span>
                    <small>{fixed
                      ? selected ? "当前二维码 · 已固定" : "已固定 · 当前不可用"
                      : selected
                        ? candidate.transportKind === "tailnet" ? "当前二维码 · Tailscale" : "当前二维码 · 自动回退"
                        : candidate.recommended ? "自动首选" : candidate.guidance ?? "选择此地址"}</small>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="muted">启动接收后将自动首选 Tailscale，也可固定热点、USB 或局域网地址。</p>
          )}
          {connectionDiagnostics?.checks.some((check) => check.status !== "ok") ? (
            <p className="muted">当前连接需要检查；请确认 Tailscale 在线，或改用热点、USB 网络。</p>
          ) : null}
        </div>
        <div className="drawer-actions">
          <button className="drawer-action" disabled={!hasNativeApi || ingestServer.running} onClick={onStartIngest} type="button">
            启动接收
          </button>
          <button className="drawer-action" disabled={!hasNativeApi || !ingestServer.running} onClick={onStopIngest} type="button">
            停止接收
          </button>
        </div>
      </section>
    </aside>
  );
}

export function SettingsModal({
  hasNativeApi,
  onClose,
  onCheckProviderHealth,
  onCreateBackup,
  onPickDirectory,
  onSaveProviderConfig,
  onSaveAssistantProviderConfig,
  onSavePromptConfig,
  onSaveNotationConfig,
  onUpdatePairingToken,
  onPreviewNotation,
  onPickProviderSelfTestImage,
  onRunProviderSelfTest,
  onExportDiagnosticReport,
  onSave,
  open,
  providerConfig,
  assistantProviderConfig,
  providerHealth,
  promptConfig,
  notationConfig,
  settings,
  ingestServer
}: {
  hasNativeApi: boolean;
  onClose: () => void;
  onCheckProviderHealth?: () => void;
  onCreateBackup?: () => void;
  onPickDirectory?: DirectoryPicker;
  onSaveProviderConfig?: (input: RecognitionProviderConfigInput) => void;
  onSaveAssistantProviderConfig?: (input: AssistantProviderConfigInput | null) => void;
  onSavePromptConfig?: (input: PromptTemplateConfig) => void;
  onSaveNotationConfig?: (input: NotationProfileConfig) => void;
  onUpdatePairingToken?: (input: UpdatePairingTokenInput) => Promise<void>;
  onPreviewNotation?: (input: NotationPreviewInput) => Promise<NotationPromptPreview>;
  onPickProviderSelfTestImage?: () => Promise<PickImageForAnnotationResult>;
  onRunProviderSelfTest?: (input: { imagePath: string; confirmedExternalCall: boolean }) => Promise<ProviderSelfTestResult>;
  onExportDiagnosticReport?: () => Promise<ExportUserDiagnosticReportResult>;
  onSave?: (settings: UserSettings) => void;
  open: boolean;
  providerConfig?: RecognitionProviderConfig | null;
  assistantProviderConfig?: AssistantProviderConfig | null;
  providerHealth?: ProviderHealthReport | null;
  promptConfig?: PromptTemplateConfig | null;
  notationConfig?: NotationProfileConfig | null;
  ingestServer?: IngestServerState;
  settings: UserSettings | null;
}) {
  return (
    <div className={`settings-modal-layer ${open ? "open" : ""}`} data-testid={open ? "settings-modal" : undefined}>
      <section aria-label="设置" className="settings-modal" role="dialog">
        <div className="settings-modal-head floating" data-testid="settings-modal-head">
          <div>
            <h2>设置</h2>
          </div>
          <button aria-label="关闭设置" className="plain-icon" onClick={onClose} type="button">
            <X />
          </button>
        </div>
        <UserSettingsForm
          key={open ? "settings-open" : "settings-closed"}
          hasNativeApi={hasNativeApi}
          onCheckProviderHealth={onCheckProviderHealth}
          onCreateBackup={onCreateBackup}
          onPickDirectory={onPickDirectory}
          onSaveProviderConfig={onSaveProviderConfig}
          onSaveAssistantProviderConfig={onSaveAssistantProviderConfig}
          onSavePromptConfig={onSavePromptConfig}
          onSaveNotationConfig={onSaveNotationConfig}
          onUpdatePairingToken={onUpdatePairingToken}
          onPreviewNotation={onPreviewNotation}
          onPickProviderSelfTestImage={onPickProviderSelfTestImage}
          onRunProviderSelfTest={onRunProviderSelfTest}
          onExportDiagnosticReport={onExportDiagnosticReport}
          settings={settings}
          onSave={onSave}
          providerConfig={providerConfig}
          assistantProviderConfig={assistantProviderConfig}
          providerHealth={providerHealth}
          promptConfig={promptConfig}
          notationConfig={notationConfig}
          ingestServer={ingestServer}
        />
      </section>
    </div>
  );
}

export function UserSettingsForm({
  hasNativeApi,
  onCheckProviderHealth,
  onCreateBackup,
  onPickDirectory,
  promptConfig,
  notationConfig,
  settings,
  onSave,
  onSavePromptConfig,
  onSaveNotationConfig,
  onUpdatePairingToken,
  onPreviewNotation,
  onPickProviderSelfTestImage,
  onRunProviderSelfTest,
  onExportDiagnosticReport,
  onSaveProviderConfig,
  onSaveAssistantProviderConfig,
  providerConfig,
  assistantProviderConfig,
  providerHealth,
  ingestServer
}: {
  hasNativeApi: boolean;
  onCheckProviderHealth?: () => void;
  onCreateBackup?: () => void;
  onPickDirectory?: DirectoryPicker;
  promptConfig?: PromptTemplateConfig | null;
  notationConfig?: NotationProfileConfig | null;
  settings: UserSettings | null;
  onSave?: (settings: UserSettings) => void;
  onSavePromptConfig?: (input: PromptTemplateConfig) => void;
  onSaveNotationConfig?: (input: NotationProfileConfig) => void;
  onUpdatePairingToken?: (input: UpdatePairingTokenInput) => Promise<void>;
  onPreviewNotation?: (input: NotationPreviewInput) => Promise<NotationPromptPreview>;
  onPickProviderSelfTestImage?: () => Promise<PickImageForAnnotationResult>;
  onRunProviderSelfTest?: (input: { imagePath: string; confirmedExternalCall: boolean }) => Promise<ProviderSelfTestResult>;
  onExportDiagnosticReport?: () => Promise<ExportUserDiagnosticReportResult>;
  onSaveProviderConfig?: (input: RecognitionProviderConfigInput) => void;
  onSaveAssistantProviderConfig?: (input: AssistantProviderConfigInput | null) => void;
  providerConfig?: RecognitionProviderConfig | null;
  assistantProviderConfig?: AssistantProviderConfig | null;
  providerHealth?: ProviderHealthReport | null;
  ingestServer?: IngestServerState;
}) {
  const [draft, setDraft] = useState<UserSettings>(
    settings ?? {
      notesRootDir: "",
      defaultExportDir: "",
      sourceFontFamily: defaultSourceFontFamily,
      sourceFontSize: 13,
      previewFontFamily: defaultPreviewFontFamily,
      previewFontSize: 16,
      assistantFontFamily: defaultAssistantFontFamily,
      assistantFontSize: 16,
      themeId: defaultThemeId,
      locale: defaultLocaleId,
      showCodexAssistant: true,
      assistantOnlineEnabled: true,
      previewFollowShortcut: DEFAULT_PREVIEW_FOLLOW_SHORTCUT
    }
  );
  const [previewShortcutFeedback, setPreviewShortcutFeedback] = useState<string | null>(null);
  const [previewShortcutIsInvalid, setPreviewShortcutIsInvalid] = useState(false);

  useEffect(() => {
    if (settings) {
      setDraft(settings);
    }
  }, [settings]);

  async function chooseDirectory(target: "notesRootDir" | "defaultExportDir", title: string): Promise<void> {
    const picked = await onPickDirectory?.({ currentPath: draft[target], title });
    if (picked) {
      setDraft({ ...draft, [target]: picked });
    }
  }

  function recordPreviewFollowShortcut(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Tab") {
      return;
    }
    const normalized = normalizeKeyboardShortcutFromEvent(event);
    if (normalized) {
      event.preventDefault();
      setDraft({ ...draft, previewFollowShortcut: normalized });
      setPreviewShortcutFeedback(`已设置为 ${normalized}`);
      setPreviewShortcutIsInvalid(false);
      return;
    }
    event.preventDefault();
    setPreviewShortcutFeedback("无效快捷键：请使用 F1-F12，或带 Ctrl/Alt/Shift/Meta 的组合键；不能只按修饰键、Escape 或裸字符。");
    setPreviewShortcutIsInvalid(true);
  }

  function restorePreviewFollowShortcut(): void {
    setDraft({ ...draft, previewFollowShortcut: DEFAULT_PREVIEW_FOLLOW_SHORTCUT });
    setPreviewShortcutFeedback(`已恢复默认 ${DEFAULT_PREVIEW_FOLLOW_SHORTCUT}`);
    setPreviewShortcutIsInvalid(false);
  }

  return (
    <div className="settings-form" data-testid="user-settings">
      <section className="settings-section">
        <div>
          <h3>文件位置</h3>
          <p>控制项目读取位置和导出默认位置。</p>
        </div>
        <div className="settings-path-fields">
          <label>
            笔记所在位置
            <div className="path-input-row">
              <input aria-label="笔记所在位置" onChange={(event) => setDraft({ ...draft, notesRootDir: event.currentTarget.value })} value={draft.notesRootDir} />
              <button
                aria-label="选择笔记所在位置"
                disabled={!hasNativeApi || !onPickDirectory}
                onClick={() => void chooseDirectory("notesRootDir", "选择笔记所在位置")}
                type="button"
              >
                <FolderOpen /> 选择
              </button>
            </div>
          </label>
          <label>
            默认导出位置
            <div className="path-input-row">
              <input
                aria-label="默认导出位置"
                onChange={(event) => setDraft({ ...draft, defaultExportDir: event.currentTarget.value })}
                placeholder="留空则保存到 Session exports"
                value={draft.defaultExportDir}
              />
              <button
                aria-label="选择默认导出位置"
                disabled={!hasNativeApi || !onPickDirectory}
                onClick={() => void chooseDirectory("defaultExportDir", "选择默认导出位置")}
                type="button"
              >
                <FolderOpen /> 选择
              </button>
            </div>
          </label>
          <div className="settings-backup-row">
            <div>
              <strong>笔记备份</strong>
              <small className="muted">只备份 Notebook、Session、block、lock 与素材；不包含 API 密钥、配对 token 和运行日志。</small>
            </div>
            <button className="settings-backup-action" disabled={!hasNativeApi || !onCreateBackup} onClick={onCreateBackup} type="button">
              <Archive /> 创建备份
            </button>
          </div>
        </div>
      </section>
      <section className="settings-section pairing-settings-section">
        <div>
          <h3>远程配对</h3>
          <p>预设一个自己记得住的高强度令牌，方便通过 Tailscale 地址在外配对。</p>
        </div>
        <PairingTokenForm
          hasNativeApi={hasNativeApi}
          ingestServer={ingestServer}
          onUpdate={onUpdatePairingToken}
        />
      </section>
      <section className="settings-section typography-section">
        <div>
          <h3>字体与字号</h3>
          <p>左侧编辑和右侧预览合并在两行里调整，并实时显示预览。</p>
        </div>
        <div className="typography-grid">
          <FontSettingRow
            fontFamily={draft.sourceFontFamily}
            fontSize={draft.sourceFontSize}
            label="左侧"
            onFontChange={(sourceFontFamily) => setDraft({ ...draft, sourceFontFamily })}
            onSizeChange={(sourceFontSize) => setDraft({ ...draft, sourceFontSize })}
            previewTestId="source-font-preview"
          />
          <FontSettingRow
            fontFamily={draft.previewFontFamily}
            fontSize={draft.previewFontSize}
            label="右侧"
            onFontChange={(previewFontFamily) => setDraft({ ...draft, previewFontFamily })}
            onSizeChange={(previewFontSize) => setDraft({ ...draft, previewFontSize })}
            previewTestId="preview-font-preview"
          />
          <FontSettingRow
            fontFamily={draft.assistantFontFamily ?? defaultAssistantFontFamily}
            fontSize={draft.assistantFontSize ?? 16}
            label="AI 回答"
            onFontChange={(assistantFontFamily) => setDraft({ ...draft, assistantFontFamily })}
            onSizeChange={(assistantFontSize) => setDraft({ ...draft, assistantFontSize })}
            previewTestId="assistant-font-preview"
          />
        </div>
      </section>
      <section className="settings-section compact-settings-section shortcut-settings-section">
        <div>
          <h3>快捷键</h3>
          <p>设置后按组合键即可让渲染区跟随当前编辑位置。</p>
        </div>
        <div className="shortcut-setting-row">
          <label>
            渲染区跟随编辑位置
            <input
              aria-invalid={previewShortcutIsInvalid || undefined}
              aria-label="渲染区跟随编辑位置"
              data-testid="preview-follow-shortcut-input"
              onFocus={() => setPreviewShortcutFeedback(null)}
              onKeyDown={recordPreviewFollowShortcut}
              readOnly
              value={draft.previewFollowShortcut ?? DEFAULT_PREVIEW_FOLLOW_SHORTCUT}
            />
            <small className="muted">按当前编辑块和光标行定位渲染区；录制时直接按新的组合键。</small>
          </label>
          <button className="drawer-secondary-action" onClick={restorePreviewFollowShortcut} type="button">
            恢复默认
          </button>
        </div>
        {previewShortcutFeedback ? (
          <p className="muted shortcut-feedback" data-testid="preview-shortcut-feedback" role="status">
            {previewShortcutFeedback}
          </p>
        ) : null}
      </section>
      <section className="settings-section">
        <div>
          <h3>识别服务</h3>
          <p>选择照片 OCR/GPT 转写服务；保存后新的导入、上传和失败重试会使用它。</p>
        </div>
        <ProviderConfigForm
          config={providerConfig ?? null}
          hasNativeApi={hasNativeApi}
          health={providerHealth}
          onCheck={onCheckProviderHealth}
          onSave={onSaveProviderConfig}
          selectLabel="识别服务"
        />
      </section>
      {assistantProviderConfig || onSaveAssistantProviderConfig ? <section className="settings-section">
        <div>
          <h3>对话模型</h3>
          <p>学习助手可以使用更聪明的独立模型；未单独保存时，实时继承上面的识别模型设置。</p>
        </div>
        <ProviderConfigForm
          config={assistantProviderConfig ?? null}
          hasNativeApi={hasNativeApi}
          inherited={assistantProviderConfig?.inherited === true}
          onRestoreInheritance={() => onSaveAssistantProviderConfig?.(null)}
          onSave={onSaveAssistantProviderConfig}
          selectLabel="对话模型服务"
        />
      </section> : null}
      <section className="settings-section">
        <div>
          <h3>提示词模板</h3>
          <p>默认数学模板不可删除；可以新建学科模板并切换，新的识别任务会使用当前模板。</p>
        </div>
        <PromptTemplateForm config={promptConfig} hasNativeApi={hasNativeApi} onSave={onSavePromptConfig} />
      </section>
      <section className="settings-section appearance-settings-section">
        <div>
          <h3>外观与语言</h3>
          <p>主题只改变语义色与对比度，不改变笔记内容和导出结果。</p>
        </div>
        <div className="appearance-settings-grid">
          <label>
            界面主题
            <select
              aria-label="界面主题"
              onChange={(event) => setDraft({ ...draft, themeId: event.currentTarget.value as UserSettings["themeId"] })}
              value={draft.themeId}
            >
              {themeOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <label>
            界面语言
            <select
              aria-label="界面语言"
              onChange={(event) => setDraft({ ...draft, locale: event.currentTarget.value as UserSettings["locale"] })}
              value={draft.locale}
            >
              {localeOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
            {draft.locale === "en-US" ? <small className="muted">当前版本仅覆盖共享基础术语，其余内容继续使用中文。</small> : null}
          </label>
        </div>
      </section>
      <section className="settings-section notation-settings-section">
        <div>
          <h3>领域记号基准</h3>
          <p>为特定数学领域提供少量消歧参考。图片证据始终优先，冲突规则不会自动进入提示词。</p>
        </div>
        <NotationProfileForm
          config={notationConfig}
          hasNativeApi={hasNativeApi}
          onPreview={onPreviewNotation}
          onSave={onSaveNotationConfig}
        />
      </section>
      <section className="settings-section diagnostics-settings-section">
        <div>
          <h3>诊断与自检</h3>
          <p>检查本机配置、显式运行一次单图完整管线，并导出不含密钥和配对凭据的报告。</p>
        </div>
        <UserDiagnosticsForm
          hasNativeApi={hasNativeApi}
          onExport={onExportDiagnosticReport}
          onPickImage={onPickProviderSelfTestImage}
          onRun={onRunProviderSelfTest}
          providerConfig={providerConfig}
        />
      </section>
      <section className="settings-section compact-settings-section assistant-settings-section">
        <div>
          <h3>学习助手</h3>
          <p>识别状态与流式日志已统一收进“任务与块信息”；这里仅控制学习助手是否可以调用在线模型。</p>
        </div>
        <label className="settings-check-row">
          <input
            checked={draft.assistantOnlineEnabled !== false}
            onChange={(event) => setDraft({ ...draft, assistantOnlineEnabled: event.currentTarget.checked })}
            type="checkbox"
          />
          <span>允许 AI 学习助手调用当前在线模型</span>
        </label>
      </section>
      <div className="settings-footer">
        <p className="muted">修改笔记所在位置后，新读取和新建 Session 会使用该目录；旧目录不会自动搬迁。</p>
        <button
          className="drawer-action"
          disabled={!hasNativeApi}
          onClick={() => onSave?.({ ...draft, previewFollowShortcut: draft.previewFollowShortcut ?? DEFAULT_PREVIEW_FOLLOW_SHORTCUT })}
          type="button"
        >
          保存设置
        </button>
      </div>
    </div>
  );
}

function FontSettingRow({
  fontFamily,
  fontSize,
  label,
  onFontChange,
  onSizeChange,
  previewTestId
}: {
  fontFamily: string;
  fontSize: number;
  label: "左侧" | "右侧" | "AI 回答";
  onFontChange: (value: string) => void;
  onSizeChange: (value: number) => void;
  previewTestId: string;
}) {
  const fontValue = fontOptions.some((option) => option.value === fontFamily) ? fontFamily : "__custom";

  return (
    <div className="font-setting-row">
      <label>
        {label}字体
        <select onChange={(event) => onFontChange(event.currentTarget.value)} value={fontValue === "__custom" ? fontFamily : fontValue}>
          {fontValue === "__custom" ? <option value={fontFamily}>{fontFamily}</option> : null}
          {fontOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        {label}字号
        <input max={28} min={11} onChange={(event) => onSizeChange(Number(event.currentTarget.value))} type="number" value={fontSize} />
      </label>
      <div className="font-preview" data-testid={previewTestId} style={{ fontFamily, fontSize: `${fontSize}px` }}>
        Aa 数学 Markdown $T_n \\to T$
      </div>
    </div>
  );
}

function PromptTemplateForm({
  config,
  hasNativeApi,
  onSave
}: {
  config?: PromptTemplateConfig | null;
  hasNativeApi: boolean;
  onSave?: (input: PromptTemplateConfig) => void;
}) {
  const [draft, setDraft] = useState<PromptTemplateConfig>(
    () =>
      config ?? {
        activeTemplateId: defaultMathPromptTemplate.id,
        templates: [defaultMathPromptTemplate]
      }
  );

  useEffect(() => {
    if (config) {
      setDraft(config);
    }
  }, [config]);

  const activeTemplate = draft.templates.find((template) => template.id === draft.activeTemplateId) ?? draft.templates[0] ?? defaultMathPromptTemplate;
  const templateLocked = activeTemplate.locked || activeTemplate.builtIn;

  function updateActiveTemplate(update: Partial<PromptTemplate>): void {
    setDraft({
      ...draft,
      templates: draft.templates.map((template) => (template.id === activeTemplate.id ? { ...template, ...update, updatedAt: new Date().toISOString() } : template))
    });
  }

  function createPromptTemplate(): void {
    const now = new Date().toISOString();
    const template: PromptTemplate = {
      id: `custom_${Date.now()}`,
      name: "未命名提示词",
      content: activeTemplate.content,
      builtIn: false,
      locked: false,
      createdAt: now,
      updatedAt: now
    };
    setDraft({
      activeTemplateId: template.id,
      templates: [...draft.templates, template]
    });
  }

  function deletePromptTemplate(): void {
    if (templateLocked) {
      return;
    }
    const templates = draft.templates.filter((template) => template.id !== activeTemplate.id);
    setDraft({
      activeTemplateId: defaultMathPromptTemplate.id,
      templates: templates.length ? templates : [defaultMathPromptTemplate]
    });
  }

  return (
    <div className="prompt-template-config" data-testid="prompt-template-config">
      <div className="prompt-template-row">
        <label>
          当前模板
          <select onChange={(event) => setDraft({ ...draft, activeTemplateId: event.currentTarget.value })} value={activeTemplate.id}>
            {draft.templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
        <button className="drawer-action" onClick={createPromptTemplate} type="button">
          新建提示词
        </button>
      </div>
      <label>
        提示词名称
        <input
          disabled={templateLocked}
          onChange={(event) => updateActiveTemplate({ name: event.currentTarget.value })}
          value={activeTemplate.name}
        />
      </label>
      <label>
        提示词内容
        <textarea
          onChange={(event) => updateActiveTemplate({ content: event.currentTarget.value })}
          readOnly={templateLocked}
          rows={8}
          value={activeTemplate.content}
        />
      </label>
      <div className="prompt-template-actions">
        <p className="muted">{templateLocked ? "内置数学模板由程序维护，不可删除或直接修改；新建模板后可编辑。" : "当前自定义模板可编辑。"}</p>
        <button className="drawer-action subtle-action" disabled={templateLocked} onClick={deletePromptTemplate} type="button">
          删除当前模板
        </button>
        <button className="drawer-action" disabled={!hasNativeApi} onClick={() => onSave?.(draft)} type="button">
          保存提示词设置
        </button>
      </div>
    </div>
  );
}

function PairingTokenForm({
  hasNativeApi,
  ingestServer,
  onUpdate
}: {
  hasNativeApi: boolean;
  ingestServer?: IngestServerState;
  onUpdate?: (input: UpdatePairingTokenInput) => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const canSubmit = hasNativeApi && Boolean(onUpdate) && token.length > 0 && confirmation.length > 0 && !saving;

  async function submit(): Promise<void> {
    if (!onUpdate) return;
    setSaving(true);
    setMessage(null);
    try {
      await onUpdate({ token, confirmation });
      setToken("");
      setConfirmation("");
      setMessage("令牌已更新，旧设备需要重新配对。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pairing-token-form">
      <div className="pairing-token-fields">
        <label>
          新配对令牌
          <input
            aria-label="新配对令牌"
            autoComplete="new-password"
            onChange={(event) => setToken(event.currentTarget.value)}
            placeholder="16-128 位字母、数字或 . _ ~ -"
            spellCheck={false}
            type="password"
            value={token}
          />
        </label>
        <label>
          再次输入
          <input
            aria-label="再次输入配对令牌"
            autoComplete="new-password"
            onChange={(event) => setConfirmation(event.currentTarget.value)}
            spellCheck={false}
            type="password"
            value={confirmation}
          />
        </label>
      </div>
      <div className="pairing-token-summary">
        <span>当前接收地址</span>
        <code title={ingestServer?.url}>{ingestServer?.running ? ingestServer.url : "接收服务未启动"}</code>
      </div>
      <div className="pairing-token-actions">
        <small className={message?.includes("已更新") ? "success-text" : "muted"} role="status">
          {message ?? "更新后接收服务会自动重启，旧手机需要使用新令牌重新配对。"}
        </small>
        <button className="settings-backup-action" disabled={!canSubmit} onClick={() => void submit()} type="button">
          {saving ? "正在应用…" : "应用新令牌"}
        </button>
      </div>
    </div>
  );
}

function NotationProfileForm({
  config,
  hasNativeApi,
  onPreview,
  onSave
}: {
  config?: NotationProfileConfig | null;
  hasNativeApi: boolean;
  onPreview?: (input: NotationPreviewInput) => Promise<NotationPromptPreview>;
  onSave?: (input: NotationProfileConfig) => void;
}) {
  const [draft, setDraft] = useState<NotationProfileConfig>(() => config ?? createEmptyNotationProfileConfig());
  const [activeProfileId, setActiveProfileId] = useState("");
  const [activeRuleId, setActiveRuleId] = useState("");
  const [previewQuery, setPreviewQuery] = useState("");
  const [preview, setPreview] = useState<NotationPromptPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (config) {
      setDraft(config);
      setActiveProfileId((current) => current || config.profiles[0]?.id || "");
    }
  }, [config]);

  const activeProfile = draft.profiles.find((profile) => profile.id === activeProfileId) ?? draft.profiles[0];
  const activeRule = activeProfile?.rules.find((rule) => rule.id === activeRuleId) ?? activeProfile?.rules[0];

  useEffect(() => {
    if (activeProfile && !activeProfile.rules.some((rule) => rule.id === activeRuleId)) {
      setActiveRuleId(activeProfile.rules[0]?.id ?? "");
    }
  }, [activeProfile, activeRuleId]);

  function createProfile(): void {
    const now = new Date().toISOString();
    const profile: NotationProfile = {
      id: `profile_${Date.now()}`,
      name: "未命名领域",
      description: "",
      enabled: true,
      status: "active",
      priority: 0,
      version: 1,
      rules: [],
      createdAt: now,
      updatedAt: now
    };
    setDraft({ ...draft, revision: draft.revision + 1, profiles: [...draft.profiles, profile] });
    setActiveProfileId(profile.id);
    setActiveRuleId("");
    setPreview(null);
  }

  function updateProfile(update: Partial<NotationProfile>): void {
    if (!activeProfile) return;
    const now = new Date().toISOString();
    setDraft({
      ...draft,
      revision: draft.revision + 1,
      profiles: draft.profiles.map((profile) =>
        profile.id === activeProfile.id
          ? { ...profile, ...update, version: profile.version + 1, updatedAt: now }
          : profile
      )
    });
    setPreview(null);
  }

  function createRule(): void {
    if (!activeProfile) return;
    const now = new Date().toISOString();
    const rule: NotationRule = {
      id: `rule_${Date.now()}`,
      kind: "symbol",
      pattern: "未定义记号",
      meaning: "请填写含义",
      aliases: [],
      keywords: [],
      enabled: true,
      status: "candidate",
      version: 1,
      source: { type: "user" },
      createdAt: now,
      updatedAt: now
    };
    updateProfile({ rules: [...activeProfile.rules, rule] });
    setActiveRuleId(rule.id);
  }

  function updateRule(update: Partial<NotationRule>): void {
    if (!activeProfile || !activeRule) return;
    const now = new Date().toISOString();
    updateProfile({
      rules: activeProfile.rules.map((rule) =>
        rule.id === activeRule.id
          ? {
              ...rule,
              ...update,
              version: rule.version + 1,
              updatedAt: now,
              approvedAt: update.status === "approved" ? now : update.status ? undefined : rule.approvedAt
            }
          : rule
      )
    });
  }

  async function runPreview(): Promise<void> {
    if (!onPreview) return;
    setPreviewing(true);
    try {
      setPreview(await onPreview({ query: previewQuery, config: draft }));
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <div className="notation-profile-config" data-testid="notation-profile-config">
      <div className="notation-profile-toolbar">
        <label>
          领域 Profile
          <select
            aria-label="领域 Profile"
            onChange={(event) => {
              setActiveProfileId(event.currentTarget.value);
              setActiveRuleId("");
              setPreview(null);
            }}
            value={activeProfile?.id ?? ""}
          >
            <option disabled value="">尚未创建</option>
            {draft.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.name}{profile.status === "retired" ? "（已退役）" : ""}</option>
            ))}
          </select>
        </label>
        <button className="drawer-action" onClick={createProfile} type="button">新建 Profile</button>
      </div>
      {activeProfile ? (
        <>
          <div className="notation-profile-fields">
            <label>
              名称
              <input aria-label="Profile 名称" onChange={(event) => updateProfile({ name: event.currentTarget.value })} value={activeProfile.name} />
            </label>
            <label>
              优先级
              <input aria-label="Profile 优先级" max={100} min={-100} onChange={(event) => updateProfile({ priority: Number(event.currentTarget.value) })} type="number" value={activeProfile.priority} />
            </label>
            <label className="settings-check-row">
              <input checked={activeProfile.enabled} disabled={activeProfile.status === "retired"} onChange={(event) => updateProfile({ enabled: event.currentTarget.checked })} type="checkbox" />
              <span>启用此 Profile</span>
            </label>
          </div>
          <label>
            说明
            <input aria-label="Profile 说明" onChange={(event) => updateProfile({ description: event.currentTarget.value })} value={activeProfile.description} />
          </label>
          <div className="notation-rule-layout">
            <div className="notation-rule-list">
              <div className="notation-rule-list-head">
                <strong>规则</strong>
                <button disabled={activeProfile.status === "retired"} onClick={createRule} type="button"><Plus /> 新建</button>
              </div>
              {activeProfile.rules.length ? activeProfile.rules.map((rule) => (
                <button className={rule.id === activeRule?.id ? "active" : ""} key={rule.id} onClick={() => setActiveRuleId(rule.id)} type="button">
                  <strong>{rule.pattern}</strong>
                  <small>{rule.status === "approved" ? "已批准" : rule.status === "candidate" ? "候选" : rule.status === "rejected" ? "已拒绝" : "已退役"}</small>
                </button>
              )) : <p className="muted">还没有规则。</p>}
            </div>
            {activeRule ? (
              <div className="notation-rule-editor">
                <div className="notation-rule-grid">
                  <label>
                    记号
                    <input aria-label="规则记号" onChange={(event) => updateRule({ pattern: event.currentTarget.value })} value={activeRule.pattern} />
                  </label>
                  <label>
                    类型
                    <select aria-label="规则类型" onChange={(event) => updateRule({ kind: event.currentTarget.value as NotationRule["kind"] })} value={activeRule.kind}>
                      <option value="symbol">符号</option>
                      <option value="convention">约定</option>
                      <option value="definition">定义</option>
                      <option value="diagram_label">图示标签</option>
                    </select>
                  </label>
                  <label>
                    状态
                    <select aria-label="规则状态" onChange={(event) => updateRule({ status: event.currentTarget.value as NotationRule["status"] })} value={activeRule.status}>
                      <option value="candidate">候选</option>
                      <option value="approved">批准</option>
                      <option value="rejected">拒绝</option>
                      <option value="retired">退役</option>
                    </select>
                  </label>
                  <label className="settings-check-row">
                    <input checked={activeRule.enabled} disabled={activeRule.status === "retired"} onChange={(event) => updateRule({ enabled: event.currentTarget.checked })} type="checkbox" />
                    <span>启用规则</span>
                  </label>
                </div>
                <label>
                  含义
                  <textarea aria-label="规则含义" onChange={(event) => updateRule({ meaning: event.currentTarget.value })} rows={3} value={activeRule.meaning} />
                </label>
                <label>
                  别名（逗号分隔）
                  <input aria-label="规则别名" onChange={(event) => updateRule({ aliases: splitList(event.currentTarget.value) })} value={activeRule.aliases.join(", ")} />
                </label>
                <label>
                  检索关键词（逗号分隔）
                  <input aria-label="规则关键词" onChange={(event) => updateRule({ keywords: splitList(event.currentTarget.value) })} value={activeRule.keywords.join(", ")} />
                </label>
              </div>
            ) : <div className="notation-rule-empty">新建或选择一条规则后编辑。</div>}
          </div>
          <div className="notation-profile-actions">
            <button
              className="drawer-secondary-action danger-menuitem"
              disabled={activeProfile.status === "retired"}
              onClick={() => updateProfile({ status: "retired", enabled: false })}
              type="button"
            >
              退役 Profile
            </button>
            <button className="drawer-action" disabled={!hasNativeApi} onClick={() => onSave?.(draft)} type="button">保存领域记号</button>
          </div>
        </>
      ) : <p className="muted">创建一个领域 Profile，再添加人工确认的记号规则。</p>}
      <div className="notation-preview">
        <label>
          预览查询
          <input aria-label="领域记号预览查询" onChange={(event) => setPreviewQuery(event.currentTarget.value)} placeholder="例如：X_+ 稳定子空间" value={previewQuery} />
        </label>
        <button className="drawer-secondary-action" disabled={!hasNativeApi || !onPreview || previewing} onClick={() => void runPreview()} type="button">
          {previewing ? "正在生成" : "预览发送内容"}
        </button>
        {preview ? (
          <div className="notation-preview-result" data-testid="notation-preview-result">
            <p>命中 {preview.selection.rules.length} 条，冲突 {preview.selection.conflicts.length} 组，预算省略 {preview.selection.omittedByBudget} 条。</p>
            <small>selection hash: {preview.selection.selectionHash}</small>
            <textarea aria-label="领域记号 Prompt 预览" readOnly rows={8} value={preview.fullPrompt} />
          </div>
        ) : null}
      </div>
      <p className="muted">内置忠实转写合约与这里分开保存，不能被 Profile 删除或覆盖。只有“批准”状态的规则会进入预览。</p>
    </div>
  );
}

function splitList(value: string): string[] {
  return value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
}

function UserDiagnosticsForm({
  hasNativeApi,
  onExport,
  onPickImage,
  onRun,
  providerConfig
}: {
  hasNativeApi: boolean;
  onExport?: () => Promise<ExportUserDiagnosticReportResult>;
  onPickImage?: () => Promise<PickImageForAnnotationResult>;
  onRun?: (input: { imagePath: string; confirmedExternalCall: boolean }) => Promise<ProviderSelfTestResult>;
  providerConfig?: RecognitionProviderConfig | null;
}) {
  const [selectedImage, setSelectedImage] = useState<{ fileName: string; sourcePath: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ProviderSelfTestResult | null>(null);
  const [message, setMessage] = useState("");
  const capability = getRecognitionProviderCapability(providerConfig?.providerId);
  const externalCall = capability.providerId !== "mock";

  async function chooseImage(): Promise<void> {
    if (!onPickImage) return;
    setMessage("");
    const picked = await onPickImage();
    if (picked.cancelled) return;
    setSelectedImage({ fileName: picked.fileName, sourcePath: picked.sourcePath });
    setResult(null);
  }

  async function runSelfTest(): Promise<void> {
    if (!selectedImage || !onRun) return;
    setRunning(true);
    setMessage("");
    try {
      const nextResult = await onRun({
        imagePath: selectedImage.sourcePath,
        confirmedExternalCall: externalCall
      });
      setResult(nextResult);
      setMessage(nextResult.status === "succeeded" ? "单图完整管线已通过。" : `自检结束：${nextResult.status}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }

  async function exportReport(): Promise<void> {
    if (!onExport) return;
    setMessage("");
    try {
      const exported = await onExport();
      if (!exported.cancelled) setMessage(`诊断报告已导出：${exported.outputPath}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="user-diagnostics" data-testid="user-diagnostics">
      <div className="diagnostic-self-test-summary">
        <strong>当前服务：{capability.label}</strong>
        <span>配置检查不会调用模型；单图自检会验证识别、草稿、导出和报告链路。</span>
      </div>
      <div className="diagnostic-self-test-actions">
        <button disabled={!hasNativeApi || !onPickImage || running} onClick={() => void chooseImage()} type="button">
          <FileCheck2 /> {selectedImage ? "更换自检图片" : "选择自检图片"}
        </button>
        {selectedImage ? <span className="diagnostic-selected-file" title={selectedImage.sourcePath}>{selectedImage.fileName}</span> : null}
      </div>
      {selectedImage ? (
        <div className={`diagnostic-confirmation ${externalCall ? "attention" : "local"}`}>
          <p>{externalCall
            ? `确认后将调用 ${capability.label} 1 次；不会自动重复，也不会把自检结果写入你的 Notebook。`
            : "假识别服务只运行本地管线，不调用外部模型。"}</p>
          <button className="drawer-action" disabled={!hasNativeApi || !onRun || running} onClick={() => void runSelfTest()} type="button">
            {running ? "自检运行中" : externalCall ? "确认并运行 1 次" : "运行本地自检"}
          </button>
        </div>
      ) : null}
      {result ? (
        <div className={`diagnostic-self-test-result ${result.status === "succeeded" ? "ok" : "attention"}`} data-testid="provider-self-test-result">
          <strong>{result.providerLabel} · {result.status === "succeeded" ? "通过" : "未通过"}</strong>
          <span>{result.elapsedMs} ms · {result.eventCount} 条事件 · {result.warningCount} 条警告</span>
        </div>
      ) : null}
      <button className="drawer-secondary-action" disabled={!hasNativeApi || !onExport || running} onClick={() => void exportReport()} type="button">
        <Download /> 导出脱敏诊断报告
      </button>
      {message ? <p className="diagnostic-user-message" role="status">{message}</p> : null}
      <details className="diagnostic-advanced-notes">
        <summary>高级与开发边界</summary>
        <p>Mock 只用于本地管线验证；Gold benchmark、全量单元测试、构建和 Harness 验证仍由 CLI/CI 执行。任何多次付费 benchmark 必须另行显示预计调用次数并再次确认。</p>
      </details>
    </div>
  );
}

function ProviderConfigForm({
  config,
  hasNativeApi,
  health,
  inherited = false,
  onCheck,
  onRestoreInheritance,
  selectLabel = "识别服务",
  onSave
}: {
  config: RecognitionProviderConfig | null;
  hasNativeApi: boolean;
  health?: ProviderHealthReport | null;
  inherited?: boolean;
  onCheck?: () => void;
  onRestoreInheritance?: () => void;
  selectLabel?: string;
  onSave?: (input: RecognitionProviderConfigInput) => void;
}) {
  const [providerId, setProviderId] = useState<RecognitionProviderConfigInput["providerId"]>(config?.providerId ?? "mock");
  const [model, setModel] = useState(config?.model ?? "mock-faithful-markdown");
  const [apiKey, setApiKey] = useState(config?.apiKey ?? "");
  const [apiKeyEnvVar, setApiKeyEnvVar] = useState(config?.apiKeyEnvVar ?? "OPENAI_API_KEY");
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? "");
  const [commandPath, setCommandPath] = useState(config?.commandPath ?? "codex");
  const [codexRuntime, setCodexRuntime] = useState<RecognitionProviderConfigInput["codexRuntime"]>(config?.codexRuntime ?? "windows");
  const [wslDistro, setWslDistro] = useState(config?.wslDistro ?? "");

  useEffect(() => {
    setProviderId(config?.providerId ?? "mock");
    setModel(config?.model ?? "mock-faithful-markdown");
    setApiKey(config?.apiKey ?? "");
    setApiKeyEnvVar(config?.apiKeyEnvVar ?? "OPENAI_API_KEY");
    setBaseUrl(config?.baseUrl ?? "");
    setCommandPath(config?.commandPath ?? "codex");
    setCodexRuntime(config?.codexRuntime ?? "windows");
    setWslDistro(config?.wslDistro ?? "");
  }, [config]);

  const assistantProfile = Boolean(onRestoreInheritance);
  const purpose = assistantProfile ? "assistant" : "recognition";
  const descriptor = PROVIDER_CATALOG[providerId];
  const providerOptions = (Object.values(PROVIDER_CATALOG) as ProviderDescriptor[]).filter((candidate) => {
    if (!candidate.allowedPurposes.includes(purpose)) return false;
    if (purpose === "recognition" && candidate.providerId !== "mock" && !candidate.supportsVision) return false;
    return true;
  });
  const networkProvider = descriptor.requiresApiKey;
  const customCompatibleProvider = providerId === "custom_openai_compatible";
  const codexProvider = providerId === "codex_cli";
  const mockProviderAvailable = import.meta.env.DEV;
  const unconfiguredProductionProvider = providerId === "mock" && !mockProviderAvailable;
  const capability = getRecognitionProviderCapability(providerId);
  const healthCheckSupported = capability.supportsHealthCheck;
  const visibleHealth = health?.providerId === providerId ? health : null;

  return (
    <div className="provider-config" data-testid="provider-config">
      {inherited ? <p className="muted" role="status">当前继承识别模型；识别设置变化时，对话模型也会同步变化。</p> : null}
      <label>
        {selectLabel}
        <select
          onChange={(event) => {
            const nextProvider = event.currentTarget.value as RecognitionProviderConfigInput["providerId"];
            setProviderId(nextProvider);
            setApiKey("");
            const nextDescriptor = PROVIDER_CATALOG[nextProvider];
            setModel(nextDescriptor.defaultModel);
            setApiKeyEnvVar(nextDescriptor.defaultApiKeyEnvVar);
            setBaseUrl(nextDescriptor.defaultBaseUrl);
            setCommandPath("");
            setCodexRuntime("windows");
            setWslDistro("");
            if (nextProvider === "codex_cli") {
              setCommandPath("codex");
              setCodexRuntime("wsl");
              setWslDistro("");
            }
          }}
          value={providerId}
        >
          {providerOptions.map((option) => (
            <option
              disabled={option.providerId === "mock" && !mockProviderAvailable}
              key={option.providerId}
              value={option.providerId}
            >
              {option.providerId === "mock" && !mockProviderAvailable ? "尚未配置真实识别服务" : option.label}
            </option>
          ))}
        </select>
      </label>
      {onRestoreInheritance ? (
        <button className="drawer-secondary-action" disabled={!hasNativeApi || inherited} onClick={onRestoreInheritance} type="button">
          恢复继承识别模型
        </button>
      ) : null}
      <label>
        模型 ID
        <input disabled={unconfiguredProductionProvider} onChange={(event) => setModel(event.currentTarget.value)} value={model} />
      </label>
      {networkProvider ? (
        <>
          <label>
            API 密钥
            <input
              aria-label="API 密钥"
              autoComplete="off"
              onChange={(event) => setApiKey(event.currentTarget.value)}
              placeholder="粘贴 API key"
              type="password"
              value={apiKey}
            />
            <small className="muted">可以直接粘贴 API key；只保存在本机配置中。留空时会尝试使用高级环境变量。</small>
          </label>
          <details className="provider-advanced">
            <summary>高级：使用环境变量保存密钥</summary>
            <label>
              API Key 环境变量名
              <input
                aria-label="API Key 环境变量名"
                onChange={(event) => setApiKeyEnvVar(event.currentTarget.value)}
                placeholder="例如 MIMO_API_KEY"
                value={apiKeyEnvVar}
              />
            </label>
          </details>
        </>
      ) : null}
      {customCompatibleProvider ? (
        <label>
          请求地址
          <input aria-label="请求地址" onChange={(event) => setBaseUrl(event.currentTarget.value)} value={baseUrl} />
          <small className="muted">仅自定义 OpenAI 兼容服务需要填写 HTTPS 地址；内置服务使用已核对的官方地址。</small>
        </label>
      ) : null}
      {codexProvider ? (
        <>
          <label>
            运行方式
            <select
              onChange={(event) => setCodexRuntime(event.currentTarget.value as RecognitionProviderConfigInput["codexRuntime"])}
              value={codexRuntime}
            >
              <option value="wsl">WSL Linux</option>
              <option value="windows">Windows 直接运行</option>
            </select>
          </label>
          <label>
            Codex 命令路径
            <input onChange={(event) => setCommandPath(event.currentTarget.value)} value={commandPath} />
          </label>
          {codexRuntime === "wsl" ? (
            <label>
              WSL 发行版
              <input onChange={(event) => setWslDistro(event.currentTarget.value)} placeholder="默认发行版" value={wslDistro} />
            </label>
          ) : null}
        </>
      ) : null}
      <p className="muted">
        状态：{unconfiguredProductionProvider
          ? assistantProfile
            ? "尚未配置真实对话模型。"
            : "尚未配置真实识别服务；新素材会保留并进入失败队列，不会生成假转写。"
          : config?.status === "missing_api_key"
            ? `缺少 API 密钥；可直接填写密钥，或在高级设置中使用 ${config.apiKeyEnvVar}`
            : "已配置"}
      </p>
      {codexProvider ? (
        <p className="muted">Codex 订阅识别不保存 API 密钥；推荐运行方式选择 WSL Linux，模型 ID 留空时使用 Codex 登录后的默认模型。</p>
      ) : null}
      {providerId === "mock" && mockProviderAvailable ? (
        <p className="muted">假识别服务：只用于验证上传、写入 block、预览和导出管线；真实识别稳定后计划移除。</p>
      ) : null}
      <button
        className="drawer-action"
        disabled={!hasNativeApi || unconfiguredProductionProvider}
        onClick={() =>
          onSave?.({
            providerId,
            model,
            apiKey,
            apiKeyEnvVar,
            baseUrl,
            commandPath,
            codexRuntime,
            wslDistro
          })
        }
        type="button"
      >
        {assistantProfile ? "保存对话模型设置" : "保存识别服务设置"}
      </button>
      {!assistantProfile ? (
        <button className="drawer-action" disabled={!hasNativeApi || !healthCheckSupported} onClick={onCheck} type="button">
          {healthCheckSupported ? "检查识别服务" : "无需健康检查"}
        </button>
      ) : null}
      {!assistantProfile && !healthCheckSupported && !unconfiguredProductionProvider ? <p className="muted">{capability.label}不需要健康检查。</p> : null}
      {visibleHealth ? <ProviderHealthView report={visibleHealth} /> : null}
      <p className="muted">{assistantProfile
        ? "保存后，新的学习助手对话会使用这个模型；识别流程继续使用上面的识别模型。"
        : "保存后，新的导入、上传和失败重试会使用这个识别服务；已有 block 不会被自动重写。"}</p>
    </div>
  );
}

function ProviderHealthView({ report }: { report: ProviderHealthReport }) {
  return (
    <div className={`diagnostics-panel provider-health ${report.ok ? "ok" : "attention"}`} data-testid="provider-health">
      <strong>{report.summary}</strong>
      <p className="muted">{report.detail}</p>
      <div className="diagnostic-checks">
        {report.checks.map((check) => (
          <div className={`diagnostic-check ${check.status}`} key={check.id}>
            <span>{check.status === "ok" ? "OK" : "!"}</span>
            <div>
              <strong>{check.label}</strong>
              <small>{check.detail}</small>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PairingQr({ payload }: { payload?: string }) {
  const [dataUrl, setDataUrl] = useState("");

  useEffect(() => {
    let cancelled = false;

    if (!payload) {
      setDataUrl("");
      return;
    }

    void QRCode.toDataURL(payload, {
      width: 300,
      margin: 4,
      errorCorrectionLevel: "M",
      color: {
        dark: "#26251f",
        light: "#fffefd"
      }
    }).then((nextDataUrl) => {
      if (!cancelled) {
        setDataUrl(nextDataUrl);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [payload]);

  if (!payload) {
    return <div className="qr-placeholder">配对二维码将在启动接收后显示</div>;
  }

  return (
    <div className="qr-card">
      {dataUrl ? <img alt="配对二维码" src={dataUrl} /> : <span>正在生成配对二维码</span>}
    </div>
  );
}

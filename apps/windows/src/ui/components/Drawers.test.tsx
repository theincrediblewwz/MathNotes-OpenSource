import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MoreDrawer, NotebookDrawer, SettingsModal, UserSettingsForm } from "./Drawers";
import { defaultAssistantFontFamily, defaultPreviewFontFamily } from "../../common/defaultUserSettings";
import { createEmptyNotationProfileConfig } from "../../common/notationProfiles";
import { defaultMathPromptTemplate } from "../../common/promptTemplates";

const settings = {
  notesRootDir: "C:\\Notes",
  defaultExportDir: "",
  sourceFontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
  sourceFontSize: 13,
  previewFontFamily: defaultPreviewFontFamily,
  previewFontSize: 16,
  assistantFontFamily: defaultAssistantFontFamily,
  assistantFontSize: 16,
  themeId: "default_light" as const,
  locale: "zh-CN" as const,
  showCodexAssistant: true
};

describe("NotebookDrawer", () => {
  const notebooks = [
    {
      notebookId: "functional_analysis",
      title: "泛函分析",
      sessionCount: 1,
      createdAt: "2026-06-30T08:00:00.000Z",
      updatedAt: "2026-06-30T08:00:00.000Z"
    }
  ];
  const sessions = [
    {
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "泛函分析 第 3 讲",
      status: "draft" as const,
      createdAt: "2026-06-30T08:00:00.000Z",
      updatedAt: "2026-06-30T08:00:00.000Z"
    }
  ];

  it("opens a visible context menu for right-click rename", () => {
    const onRenameSession = vi.fn();
    const onDeleteSession = vi.fn();

    render(
      <NotebookDrawer
        onClose={() => undefined}
        onDeleteSession={onDeleteSession}
        onRenameSession={onRenameSession}
        openLayer="notebook"
        sessionId="lecture"
        sessions={sessions}
      />
    );

    const sessionRow = screen.getByRole("button", { name: "泛函分析 第 3 讲lecture" });
    screen.getByTestId("notebook-drawer").getBoundingClientRect = () =>
      ({
        bottom: 520,
        height: 448,
        left: 16,
        right: 336,
        top: 72,
        width: 320,
        x: 16,
        y: 72,
        toJSON: () => undefined
      }) as DOMRect;

    fireEvent.contextMenu(sessionRow, { clientX: 68, clientY: 224 });

    expect(screen.getByTestId("session-context-menu").style.left).toBe("52px");
    expect(screen.getByTestId("session-context-menu").style.top).toBe("152px");
    fireEvent.click(screen.getByRole("menuitem", { name: "删除 Session" }));

    expect(onDeleteSession).toHaveBeenCalledWith(sessions[0]);

    fireEvent.contextMenu(sessionRow, { clientX: 68, clientY: 224 });
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名 Session" }));

    expect(onRenameSession).toHaveBeenCalledWith(sessions[0]);
  });

  it("exposes settings from the notebook drawer", () => {
    const onOpenSettings = vi.fn();

    render(
      <NotebookDrawer
        onClose={() => undefined}
        onOpenSettings={onOpenSettings}
        openLayer="notebook"
        sessionId="lecture"
        sessions={sessions}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("exposes real notebook switching and creation", () => {
    const onCreateNotebook = vi.fn();
    const onOpenNotebook = vi.fn();
    render(
      <NotebookDrawer
        notebookId="functional_analysis"
        notebooks={notebooks}
        onClose={() => undefined}
        onCreateNotebook={onCreateNotebook}
        onOpenNotebook={onOpenNotebook}
        openLayer="notebook"
        sessionId="lecture"
        sessions={sessions}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "新建 Notebook" }));
    fireEvent.click(screen.getByRole("button", { name: "泛函分析1 个 Session" }));

    expect(onCreateNotebook).toHaveBeenCalledTimes(1);
    expect(onOpenNotebook).toHaveBeenCalledWith(notebooks[0]);
  });

  it("clears the session context menu when the drawer is closed and reopened", () => {
    const { rerender } = render(
      <NotebookDrawer
        onClose={() => undefined}
        openLayer="notebook"
        sessionId="lecture"
        sessions={sessions}
      />
    );
    const sessionRow = screen.getByRole("button", { name: "泛函分析 第 3 讲lecture" });

    fireEvent.contextMenu(sessionRow, { clientX: 68, clientY: 224 });
    expect(screen.getByTestId("session-context-menu")).toBeTruthy();

    rerender(
      <NotebookDrawer
        onClose={() => undefined}
        openLayer={null}
        sessionId="lecture"
        sessions={sessions}
      />
    );
    rerender(
      <NotebookDrawer
        onClose={() => undefined}
        openLayer="notebook"
        sessionId="lecture"
        sessions={sessions}
      />
    );

    expect(screen.queryByTestId("session-context-menu")).toBeNull();
  });
});

describe("MoreDrawer", () => {
  it("shows Tailscale-first automatic mode and can restore it after a fixed address", () => {
    const onSelectIngestHost = vi.fn();
    render(
      <MoreDrawer
        ingestServer={{
          running: true,
          displayHost: "192.168.1.20",
          preferredHost: "192.168.1.20",
          url: "http://192.168.1.20:4095",
          addressCandidates: [
            {
              label: "Tailscale",
              address: "100.92.105.105",
              internal: false,
              usable: true,
              recommended: true,
              transportKind: "tailnet"
            },
            {
              label: "WLAN",
              address: "192.168.1.20",
              internal: false,
              usable: true,
              transportKind: "private_lan"
            }
          ]
        }}
        onClose={() => undefined}
        onSelectIngestHost={onSelectIngestHost}
        openLayer="more"
      />
    );

    expect(screen.getByText("已固定 192.168.1.20")).toBeTruthy();
    expect(screen.getByText("当前二维码 · 已固定")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "自动选择Tailscale 优先恢复自动" }));
    expect(onSelectIngestHost).toHaveBeenCalledWith(null);
  });

  it("labels an automatically selected tailnet address", () => {
    render(
      <MoreDrawer
        ingestServer={{
          running: true,
          displayHost: "100.92.105.105",
          transportKind: "tailnet",
          url: "http://100.92.105.105:4095",
          addressCandidates: [{
            label: "Tailscale",
            address: "100.92.105.105",
            internal: false,
            usable: true,
            recommended: true,
            transportKind: "tailnet"
          }]
        }}
        onClose={() => undefined}
        openLayer="more"
      />
    );

    expect(screen.getByText("自动选择 · Tailscale 优先")).toBeTruthy();
    expect(screen.getByText("当前二维码 · Tailscale")).toBeTruthy();
  });
});

describe("UserSettingsForm", () => {
  it("creates a notes-only backup from settings", () => {
    const onCreateBackup = vi.fn();

    render(<UserSettingsForm hasNativeApi settings={settings} onCreateBackup={onCreateBackup} />);

    expect(screen.getByText("不包含 API 密钥、配对 token 和运行日志。", { exact: false })).toBeTruthy();
    const backupButton = screen.getByRole("button", { name: "创建备份" });
    expect(backupButton.className).toContain("settings-backup-action");
    fireEvent.click(backupButton);
    expect(onCreateBackup).toHaveBeenCalledTimes(1);
  });

  it("chooses note and export directories through a picker", async () => {
    const onPickDirectory = vi.fn().mockResolvedValueOnce("D:\\MathNotes").mockResolvedValueOnce("D:\\Exports");

    render(<UserSettingsForm hasNativeApi settings={settings} onPickDirectory={onPickDirectory} />);

    fireEvent.click(screen.getByRole("button", { name: "选择笔记所在位置" }));
    await waitFor(() => expect((screen.getByLabelText("笔记所在位置") as HTMLInputElement).value).toBe("D:\\MathNotes"));

    fireEvent.click(screen.getByRole("button", { name: "选择默认导出位置" }));
    await waitFor(() => expect((screen.getByLabelText("默认导出位置") as HTMLInputElement).value).toBe("D:\\Exports"));
  });

  it("uses compact font controls with live previews", () => {
    render(<UserSettingsForm hasNativeApi settings={settings} />);

    expect(screen.getByLabelText("左侧字体").tagName).toBe("SELECT");
    expect(screen.getByLabelText("右侧字体").tagName).toBe("SELECT");
    expect(screen.getByLabelText("AI 回答字体").tagName).toBe("SELECT");
    expect(screen.getByTestId("source-font-preview").style.fontSize).toBe("13px");
    expect(screen.getByTestId("preview-font-preview").style.fontSize).toBe("16px");
    expect(screen.getByTestId("assistant-font-preview").style.fontSize).toBe("16px");
  });

  it("keeps learning-assistant and appearance settings without an obsolete recognition HUD toggle", () => {
    render(<UserSettingsForm hasNativeApi settings={settings} />);

    expect(screen.queryByLabelText("显示识别服务悬浮助手")).toBeNull();
    expect((screen.getByLabelText("允许 AI 学习助手调用当前在线模型") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/识别状态与流式日志已统一收进/)).toBeTruthy();
    expect((screen.getByLabelText("界面主题") as HTMLSelectElement).value).toBe("default_light");
    expect((screen.getByLabelText("界面语言") as HTMLSelectElement).value).toBe("zh-CN");
    expect(screen.queryByText("显示 Codex 悬浮助手")).toBeNull();
  });

  it("updates the preset pairing token only through explicit confirmation", async () => {
    const onUpdatePairingToken = vi.fn().mockResolvedValue(undefined);

    render(
      <UserSettingsForm
        hasNativeApi
        ingestServer={{ running: true, url: "http://100.78.165.118:3078" }}
        onUpdatePairingToken={onUpdatePairingToken}
        settings={settings}
      />
    );

    fireEvent.change(screen.getByLabelText("新配对令牌"), { target: { value: "MathNotes-Remote_2026" } });
    fireEvent.change(screen.getByLabelText("再次输入配对令牌"), { target: { value: "MathNotes-Remote_2026" } });
    fireEvent.click(screen.getByRole("button", { name: "应用新令牌" }));

    await waitFor(() => expect(onUpdatePairingToken).toHaveBeenCalledWith({
      token: "MathNotes-Remote_2026",
      confirmation: "MathNotes-Remote_2026"
    }));
    expect(await screen.findByText("令牌已更新，旧设备需要重新配对。")).toBeTruthy();
  });

  it("creates and saves a selectable custom prompt template", () => {
    const onSavePromptConfig = vi.fn();

    render(
      <UserSettingsForm
        hasNativeApi
        onSavePromptConfig={onSavePromptConfig}
        promptConfig={{
          activeTemplateId: defaultMathPromptTemplate.id,
          templates: [defaultMathPromptTemplate]
        }}
        settings={settings}
      />
    );

    expect(screen.getByTestId("prompt-template-config").textContent).toContain("数学忠实转写");
    expect((screen.getByLabelText("提示词内容") as HTMLTextAreaElement).readOnly).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "新建提示词" }));
    fireEvent.change(screen.getByLabelText("提示词名称"), { target: { value: "物理板书" } });
    fireEvent.change(screen.getByLabelText("提示词内容"), { target: { value: "请忠实转写物理板书。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存提示词设置" }));

    expect(onSavePromptConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTemplateId: expect.stringMatching(/^custom_/),
        templates: expect.arrayContaining([
          expect.objectContaining({
            name: "物理板书",
            content: "请忠实转写物理板书。"
          })
        ])
      })
    );
  });

  it("creates, approves, saves and previews a notation rule without invoking a provider", async () => {
    const onSaveNotationConfig = vi.fn();
    const onPreviewNotation = vi.fn().mockResolvedValue({
      fullPrompt: "faithful contract\n领域记号参考：X_+ 表示稳定子空间",
      selection: {
        rules: [{
          profileId: "profile_test",
          profileName: "泛函分析",
          profilePriority: 0,
          ruleId: "rule_test",
          pattern: "X_+",
          meaning: "稳定子空间",
          aliases: [],
          keywords: ["稳定"],
          score: 500,
          contentHash: "rule-hash"
        }],
        conflicts: [],
        omittedByBudget: 0,
        selectionHash: "selection-hash",
        promptFragment: "领域记号参考：X_+ 表示稳定子空间"
      }
    });

    render(
      <UserSettingsForm
        hasNativeApi
        notationConfig={createEmptyNotationProfileConfig()}
        onPreviewNotation={onPreviewNotation}
        onSaveNotationConfig={onSaveNotationConfig}
        settings={settings}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "新建 Profile" }));
    fireEvent.change(screen.getByLabelText("Profile 名称"), { target: { value: "泛函分析" } });
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    fireEvent.change(screen.getByLabelText("规则记号"), { target: { value: "X_+" } });
    fireEvent.change(screen.getByLabelText("规则含义"), { target: { value: "稳定子空间" } });
    fireEvent.change(screen.getByLabelText("规则关键词"), { target: { value: "稳定" } });
    fireEvent.change(screen.getByLabelText("规则状态"), { target: { value: "approved" } });
    fireEvent.click(screen.getByRole("button", { name: "保存领域记号" }));

    expect(onSaveNotationConfig).toHaveBeenCalledWith(expect.objectContaining({
      profiles: [expect.objectContaining({
        name: "泛函分析",
        rules: [expect.objectContaining({ pattern: "X_+", meaning: "稳定子空间", status: "approved" })]
      })]
    }));

    fireEvent.change(screen.getByLabelText("领域记号预览查询"), { target: { value: "X_+ 稳定子空间" } });
    fireEvent.click(screen.getByRole("button", { name: "预览发送内容" }));

    await waitFor(() => expect(onPreviewNotation).toHaveBeenCalledWith(expect.objectContaining({
      query: "X_+ 稳定子空间",
      config: expect.any(Object)
    })));
    expect(await screen.findByText("selection hash: selection-hash")).toBeTruthy();
    expect((screen.getByLabelText("领域记号 Prompt 预览") as HTMLTextAreaElement).value).toContain("X_+");
  });
});

describe("SettingsModal", () => {
  it("configures a separate dialogue model and can restore recognition inheritance", () => {
    const onSaveAssistantProviderConfig = vi.fn();
    render(
      <SettingsModal
        assistantProviderConfig={{
          providerId: "deepseek",
          model: "deepseek-chat",
          apiKeyEnvVar: "DEEPSEEK_API_KEY",
          baseUrl: "https://api.deepseek.com/chat/completions",
          status: "configured",
          purpose: "assistant",
          inherited: true
        }}
        hasNativeApi
        onClose={() => undefined}
        onSaveAssistantProviderConfig={onSaveAssistantProviderConfig}
        open
        settings={settings}
      />
    );

    expect(screen.getByText("对话模型")).toBeTruthy();
    expect(screen.getByText(/当前继承识别模型/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "恢复继承识别模型" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("对话模型服务"), { target: { value: "openai_vision" } });
    fireEvent.click(screen.getByRole("button", { name: "保存对话模型设置" }));
    expect(onSaveAssistantProviderConfig).toHaveBeenCalledWith(expect.objectContaining({ providerId: "openai_vision", model: "gpt-4.1-mini" }));
  });

  it("keeps recognition provider configuration in settings", () => {
    render(
      <SettingsModal
        hasNativeApi
        onClose={() => undefined}
        open
        providerConfig={{
          providerId: "codex_cli",
          model: "",
          apiKeyEnvVar: "",
          commandPath: "/home/mathnotes/.local/bin/codex-proxy",
          codexRuntime: "wsl",
          wslDistro: "Ubuntu-24.04",
          status: "configured"
        }}
        settings={settings}
      />
    );

    expect(screen.getByTestId("settings-modal").textContent).toContain("识别服务");
    expect(screen.getByTestId("provider-config").textContent).toContain("Codex 订阅识别");
    expect((screen.getByRole("button", { name: "保存识别服务设置" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("renders the title bar as a floating overlay above settings content", () => {
    render(<SettingsModal hasNativeApi onClose={() => undefined} open settings={settings} />);

    const head = screen.getByTestId("settings-modal-head");
    expect(head.className).toContain("floating");
    expect(head.textContent).toBe("设置");
    expect(head.textContent).not.toContain("Settings");
    expect(screen.getByRole("button", { name: "关闭设置" })).toBeTruthy();
  });

  it("discards unsaved typography drafts when settings is reopened", () => {
    const { rerender } = render(<SettingsModal hasNativeApi onClose={() => undefined} open settings={settings} />);

    fireEvent.change(screen.getByLabelText("左侧字号"), { target: { value: "22" } });
    expect((screen.getByLabelText("左侧字号") as HTMLInputElement).value).toBe("22");

    rerender(<SettingsModal hasNativeApi onClose={() => undefined} open={false} settings={settings} />);
    rerender(<SettingsModal hasNativeApi onClose={() => undefined} open settings={settings} />);

    expect((screen.getByLabelText("左侧字号") as HTMLInputElement).value).toBe(String(settings.sourceFontSize));
  });

  it("uses provider capability to disable health check for mock providers", () => {
    render(
      <SettingsModal
        hasNativeApi
        onClose={() => undefined}
        open
        providerConfig={{
          providerId: "mock",
          model: "mock-faithful-markdown",
          apiKeyEnvVar: "OPENAI_API_KEY",
          status: "configured"
        }}
        settings={settings}
      />
    );

    expect(screen.getByText("假识别服务（验证管线）")).toBeTruthy();
    expect(screen.getByText("假识别服务：只用于验证上传、写入 block、预览和导出管线；真实识别稳定后计划移除。")).toBeTruthy();
    expect(screen.getByText("假识别服务（验证管线）不需要健康检查。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "无需健康检查" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers DeepSeek only to dialogue and uses the current built-in defaults", () => {
    render(
      <SettingsModal
        assistantProviderConfig={{
          providerId: "openai_vision",
          model: "gpt-4.1-mini",
          apiKeyEnvVar: "OPENAI_API_KEY",
          baseUrl: "https://api.openai.com/v1",
          status: "configured",
          purpose: "assistant",
          inherited: false
        }}
        hasNativeApi
        onClose={() => undefined}
        open
        providerConfig={{
          providerId: "mock",
          model: "mock-faithful-markdown",
          apiKeyEnvVar: "OPENAI_API_KEY",
          status: "configured"
        }}
        settings={settings}
      />
    );
    expect([...((screen.getByLabelText("识别服务") as HTMLSelectElement).options)].map((item) => item.value)).not.toContain("deepseek");
    fireEvent.change(screen.getByLabelText("对话模型服务"), { target: { value: "deepseek" } });
    const modelInputs = screen.getAllByLabelText("模型 ID") as HTMLInputElement[];
    expect(modelInputs.at(-1)?.value).toBe("deepseek-v4-flash");
  });

  it("uses direct API key and base request URL as the default network provider setup", () => {
    const onSaveProviderConfig = vi.fn();

    render(
      <SettingsModal
        hasNativeApi
        onClose={() => undefined}
        onSaveProviderConfig={onSaveProviderConfig}
        open
        providerConfig={{
          providerId: "mock",
          model: "mock-faithful-markdown",
          apiKeyEnvVar: "OPENAI_API_KEY",
          status: "configured"
        }}
        settings={settings}
      />
    );

    fireEvent.change(screen.getByLabelText("识别服务"), { target: { value: "mimo_2_5" } });
    expect((screen.getByLabelText("模型 ID") as HTMLInputElement).value).toBe("mimo-v2.5");
    expect((screen.getByLabelText("API 密钥") as HTMLInputElement).type).toBe("password");
    expect(screen.queryByLabelText("请求地址")).toBeNull();
    expect(screen.getByText("高级：使用环境变量保存密钥")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("API 密钥"), { target: { value: "mimo-direct-key" } });
    fireEvent.click(screen.getByRole("button", { name: "保存识别服务设置" }));

    expect(onSaveProviderConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "mimo_2_5",
        model: "mimo-v2.5",
        apiKey: "mimo-direct-key",
        apiKeyEnvVar: "MIMO_API_KEY",
        baseUrl: "https://api.xiaomimimo.com/v1"
      })
    );
  });

  it("requires an explicit one-call action and exports a redacted diagnostic report", async () => {
    const onPickProviderSelfTestImage = vi.fn().mockResolvedValue({
      cancelled: false,
      fileName: "blackboard.png",
      sourcePath: "C:\\private\\blackboard.png"
    });
    const onRunProviderSelfTest = vi.fn().mockResolvedValue({
      providerId: "mimo_2_5",
      providerLabel: "MiMo v2.5",
      model: "mimo-v2.5",
      status: "succeeded",
      warningCount: 0,
      eventCount: 8,
      previewUpdateCount: 3,
      elapsedMs: 1250,
      reportPath: "C:\\private\\report.json",
      exportPath: "C:\\private\\draft.md"
    });
    const onExportDiagnosticReport = vi.fn().mockResolvedValue({
      cancelled: false,
      outputPath: "C:\\exports\\diagnostics.json",
      report: {}
    });

    render(
      <SettingsModal
        hasNativeApi
        onClose={() => undefined}
        onExportDiagnosticReport={onExportDiagnosticReport}
        onPickProviderSelfTestImage={onPickProviderSelfTestImage}
        onRunProviderSelfTest={onRunProviderSelfTest}
        open
        providerConfig={{
          providerId: "mimo_2_5",
          model: "mimo-v2.5",
          apiKeyEnvVar: "MIMO_API_KEY",
          baseUrl: "https://api.xiaomimimo.com/v1",
          status: "configured"
        }}
        settings={settings}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "选择自检图片" }));
    expect(await screen.findByText("blackboard.png")).toBeTruthy();
    expect(screen.getByText(/确认后将调用 .* 1 次/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "确认并运行 1 次" }));
    await waitFor(() => expect(onRunProviderSelfTest).toHaveBeenCalledWith({
      imagePath: "C:\\private\\blackboard.png",
      confirmedExternalCall: true
    }));
    expect(await screen.findByText("MiMo v2.5 · 通过")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "导出脱敏诊断报告" }));
    await waitFor(() => expect(onExportDiagnosticReport).toHaveBeenCalledTimes(1));
  });
});

describe("MoreDrawer", () => {
  it("shows one-time device pairing and lets the user revoke a paired phone", () => {
    const onRefreshDevicePairing = vi.fn();
    const onRevokePairedDevice = vi.fn();
    render(
      <MoreDrawer
        hasNativeApi
        ingestServer={{
          running: true,
          displayHost: "100.88.1.2",
          token: "legacy-token",
          devicePairingPayload: "mathnotes://pair?v=2&challenge=challenge-1&code=ABCD-EFGH",
          devicePairingCode: "ABCD-EFGH",
          pairedDevices: [{
            deviceId: "device-1",
            label: "Xiaomi 15",
            createdAt: "2026-07-25T08:00:00.000Z",
            lastSeenAt: "2026-07-25T09:00:00.000Z",
            scopes: ["session:read", "asset:write"]
          }]
        }}
        onClose={() => undefined}
        onRefreshDevicePairing={onRefreshDevicePairing}
        onRevokePairedDevice={onRevokePairedDevice}
        openLayer="more"
      />
    );

    expect(screen.getByText(/同一 Wi-Fi、iPhone 热点和 Tailscale/)).toBeTruthy();
    expect(screen.getByText("第一次连接手机")).toBeTruthy();
    expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
    expect(screen.getByText("Xiaomi 15")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "刷新二维码" }));
    expect(onRefreshDevicePairing).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    fireEvent.click(screen.getByRole("button", { name: "确认撤销" }));
    expect(onRevokePairedDevice).toHaveBeenCalledWith("device-1");
  });

  it("lets the user switch the advertised private address while receiving", async () => {
    const onSelectIngestHost = vi.fn();
    const onRefreshIngestAddresses = vi.fn();
    const onCopyPairingToken = vi.fn();
    render(
      <MoreDrawer
        hasNativeApi
        ingestServer={{
          running: true,
          displayHost: "172.24.118.183",
          port: 4173,
          token: "manual-pairing-token-1234",
          addressCandidates: [
            { label: "WLAN", address: "172.24.118.183", internal: false, usable: true, transportKind: "private_lan" },
            { label: "Tailscale", address: "100.88.1.2", internal: false, usable: true, transportKind: "tailnet" },
            { label: "Meta", address: "198.18.0.1", internal: false, usable: false }
          ]
        }}
        onClose={() => undefined}
        onCopyPairingToken={onCopyPairingToken}
        onRefreshIngestAddresses={onRefreshIngestAddresses}
        onSelectIngestHost={onSelectIngestHost}
        openLayer="more"
      />
    );

    expect(screen.queryByRole("button", { name: /Meta/ })).toBeNull();
    expect(screen.getByTestId("pairing-token").textContent).not.toContain("manual-pairing-token-1234");
    fireEvent.click(screen.getByRole("button", { name: "显示配对令牌" }));
    expect(screen.getByTestId("pairing-token").textContent).toBe("manual-pairing-token-1234");
    fireEvent.click(screen.getByText("第一次连接手机"));
    expect(screen.getByText("http://172.24.118.183:4173")).toBeTruthy();
    expect(screen.getByText("http://100.88.1.2:4173")).toBeTruthy();
    expect(screen.getByText("iPhone / PWA")).toBeTruthy();
    expect(screen.getByText("Android App")).toBeTruthy();
    expect(screen.getByText(/不会把 IP 地址冒充 HTTPS 域名/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "复制配对令牌" }));
    expect(onCopyPairingToken).toHaveBeenCalledWith("manual-pairing-token-1234");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(onRefreshIngestAddresses).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /WLAN/ }));
    expect(onSelectIngestHost).toHaveBeenCalledWith("172.24.118.183");
  });

  it("does not keep recognition provider configuration in hidden system info", () => {
    render(<MoreDrawer hasNativeApi openLayer="more" onClose={() => undefined} />);

    expect(screen.getByTestId("more-drawer").textContent).not.toContain("识别服务");
    expect(screen.queryByTestId("provider-config")).toBeNull();
  });

  it("does not duplicate export settings that already live in the export panel and settings", () => {
    render(<MoreDrawer hasNativeApi openLayer="more" onClose={() => undefined} />);

    expect(screen.getByTestId("more-drawer").textContent).not.toContain("导出设置");
  });
});

import { useEffect, useState, type ChangeEvent } from "react";
import {
  addStandaloneAsset,
  createStandaloneExport,
  createStandaloneSession,
  listAllStandaloneAssets,
  listStandaloneAssets,
  listStandaloneSessions,
  parseStandaloneExport,
  restoreStandaloneExport,
  saveStandaloneMarkdown,
  type StandaloneAsset,
  type StandaloneSession
} from "./standaloneStorage";
import { discoverSameOriginGateway } from "./standaloneGatewayDiscovery";
import { recognizeViaGateway } from "./standaloneGatewayClient";

export default function StandaloneApp({ onConnectComputer }: Readonly<{ onConnectComputer(): void }>) {
  const [sessions, setSessions] = useState<StandaloneSession[]>([]);
  const [active, setActive] = useState<StandaloneSession>();
  const [assets, setAssets] = useState<StandaloneAsset[]>([]);
  const [persistence, setPersistence] = useState("正在检查本地存储…");
  const [message, setMessage] = useState("");
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [gatewayToken, setGatewayToken] = useState("");

  async function refresh() {
    const next = await listStandaloneSessions();
    setSessions(next);
    setActive((current) => next.find((item) => item.id === current?.id) ?? next[0]);
  }

  useEffect(() => {
    void Promise.all([
      refresh(),
      navigator.storage?.persist?.().then((granted) => setPersistence(granted ? "持久存储已允许" : "浏览器仍可能清理数据，请定期导出"))
        ?? Promise.resolve(setPersistence("浏览器未提供持久存储接口，请定期导出"))
    ]).catch((error) => setMessage(error instanceof Error ? error.message : "独立工作区启动失败"));
    void discoverSameOriginGateway({ origin: window.location.origin }).then((discovered) => {
      if (discovered) setGatewayUrl((current) => current.trim() ? current : discovered);
    });
  }, []);

  useEffect(() => {
    if (!active) { setAssets([]); return; }
    void listStandaloneAssets(active.id).then(setAssets).catch((error) => setMessage(String(error)));
  }, [active?.id]);

  async function createSession() {
    const created = await createStandaloneSession();
    await refresh();
    setActive(created);
  }

  async function importImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!active || !file) return;
    await addStandaloneAsset(active.id, file);
    setAssets(await listStandaloneAssets(active.id));
    setMessage("图片已保存在这个浏览器的独立工作区。");
    event.target.value = "";
  }

  async function downloadBackup() {
    const blob = new Blob([await createStandaloneExport(sessions, await listAllStandaloneAssets())], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `MathNotes-standalone-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function restoreBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    await restoreStandaloneExport(parseStandaloneExport(await file.text()));
    await refresh();
    setMessage("Session 与图片资产已从备份恢复。 ");
  }

  return <main className="standalone-shell">
    <header className="standalone-header">
      <div><span>MathNotes</span><strong>手机独立</strong></div>
      <button type="button" onClick={onConnectComputer}>连接电脑</button>
    </header>
    <section className="standalone-content">
      <div className="standalone-notice"><strong>本机工作区</strong><p>无需电脑地址、配对码或 Tailscale。数据与电脑伴侣缓存隔离，不会自动合并。</p><small>{persistence}</small></div>
      <div className="standalone-actions">
        <button type="button" onClick={() => void createSession()}>新建 Session</button>
        <button type="button" onClick={() => void downloadBackup()} disabled={sessions.length === 0}>导出备份</button>
        <label>恢复备份<input type="file" accept="application/json" onChange={(event) => void restoreBackup(event)} /></label>
      </div>
      <div className="standalone-notice gateway-settings">
        <strong>独立识别 Gateway（可选）</strong>
        <p>地址和临时令牌只保留在当前页面内存，不写入 IndexedDB、Service Worker 或导出包。</p>
        <input aria-label="Gateway 地址" placeholder="https://gateway.example" value={gatewayUrl} onChange={(event) => setGatewayUrl(event.target.value)} />
        <input aria-label="Gateway 临时令牌" type="password" autoComplete="off" value={gatewayToken} onChange={(event) => setGatewayToken(event.target.value)} />
      </div>
      {active ? <article className="standalone-editor">
        <input aria-label="Session 标题" value={active.title} readOnly />
        <textarea aria-label="Markdown 草稿" value={active.markdown} onChange={(event) => {
          const markdown = event.target.value;
          setActive({ ...active, markdown });
        }} onBlur={() => void saveStandaloneMarkdown(active, active.markdown).then(refresh)} />
        <label className="standalone-file">加入图片<input type="file" accept="image/*" capture="environment" onChange={(event) => void importImage(event)} /></label>
        <button type="button" disabled={assets.length === 0} onClick={() => {
          const run = async () => {
            const markdown = gatewayUrl.trim()
              ? (await recognizeViaGateway({ gatewayUrl, token: gatewayToken, sessionId: active.id, asset: assets[0].bytes, fileName: assets[0].name })).markdown
              : `## 识别草稿\n\n[本地假识别] 已读取 ${assets[0].name}。此草稿没有发送到网络，也没有产生费用。`;
            const saved = await saveStandaloneMarkdown(active, `${active.markdown.trimEnd()}\n\n${markdown}\n`);
            setActive(saved);
            setMessage(gatewayUrl.trim() ? "Gateway 草稿已保存" : "本地假识别草稿已保存");
            await refresh();
          };
          void run().catch((error) => setMessage(error instanceof Error ? error.message : "识别失败"));
        }}>{gatewayUrl.trim() ? "确认调用一次 Gateway" : "确认运行一次本地假识别"}</button>
        <p>{assets.length} 张本地图片 · 未填写 Gateway 时不会发送或计费。</p>
      </article> : <div className="standalone-empty">新建一个 Session，开始离线记录。</div>}
      {message ? <p role="status" className="standalone-message">{message}</p> : null}
    </section>
  </main>;
}

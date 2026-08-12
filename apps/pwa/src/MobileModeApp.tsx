import { lazy, Suspense, useState } from "react";
import CompanionApp from "./App";

const StandaloneApp = lazy(() => import("./StandaloneApp"));
type MobileMode = "standalone" | "companion";
const MODE_KEY = "mathnotes:mobile-mode:v1";

export default function MobileModeApp() {
  const [mode, setMode] = useState<MobileMode>(() => localStorage.getItem(MODE_KEY) === "companion" ? "companion" : "standalone");
  const selectMode = (next: MobileMode) => { localStorage.setItem(MODE_KEY, next); setMode(next); };
  if (mode === "companion") return <div className="mode-frame"><button className="mode-return" type="button" onClick={() => selectMode("standalone")}>切换到手机独立</button><CompanionApp /></div>;
  return <Suspense fallback={<div className="standalone-loading">正在打开本地工作区…</div>}><StandaloneApp onConnectComputer={() => selectMode("companion")} /></Suspense>;
}

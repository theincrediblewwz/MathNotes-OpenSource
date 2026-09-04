import { lazy, Suspense, useState } from "react";
import CompanionApp from "./App";

const StandaloneApp = lazy(() => import("./StandaloneApp"));
type MobileMode = "standalone" | "companion";
const MODE_KEY = "mathnotes:mobile-mode:v1";

export default function MobileModeApp() {
  const [mode, setMode] = useState<MobileMode>(() => localStorage.getItem(MODE_KEY) === "standalone" ? "standalone" : "companion");
  const selectMode = (next: MobileMode) => { localStorage.setItem(MODE_KEY, next); setMode(next); };
  if (mode === "companion") return <CompanionApp />;
  return <Suspense fallback={<div className="standalone-loading">正在打开本地工作区…</div>}><StandaloneApp onConnectComputer={() => selectMode("companion")} /></Suspense>;
}

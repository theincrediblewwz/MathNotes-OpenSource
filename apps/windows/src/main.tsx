import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// Keep the HTML startup shell visible while the editor and math renderer load.
// Import immediately: delaying until an animation frame slows down readiness.
void import("./App").then(({ App }) => {
  createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
}).catch(() => {
  const status = document.querySelector(".startup-shell span");
  if (status) status.textContent = "打开界面失败，请重试。";
  const retry = document.createElement("button");
  retry.textContent = "重试";
  retry.onclick = () => window.location.reload();
  document.querySelector(".startup-shell")?.append(retry);
});

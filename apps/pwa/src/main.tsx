import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import MobileModeApp from "./MobileModeApp";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MobileModeApp />
  </StrictMode>
);

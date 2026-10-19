import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const browserPlatform = navigator.platform.toLowerCase();
document.documentElement.dataset.platform = browserPlatform.includes("mac")
  ? "macos"
  : browserPlatform.includes("win")
    ? "windows"
    : "other";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Renderer root is missing.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

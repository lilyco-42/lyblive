import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { OverlayView } from "@/modules/danmu-overlay/OverlayView";
import { initScale } from "@/lib/ui-scale";

// 浮层页不需要整站缩放（它按 OBS 画布尺寸渲染），但普通页面要恢复偏好
const isOverlay = globalThis.location?.pathname === "/overlay";
if (!isOverlay) {
  initScale();
}

const container = document.getElementById("root");
if (container === null) {
  throw new Error("找不到 #root 挂载点");
}

createRoot(container).render(
  <StrictMode>{isOverlay ? <OverlayView /> : <App />}</StrictMode>,
);
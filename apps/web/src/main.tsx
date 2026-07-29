import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./i18n/i18n.ts";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("root 要素が見つかりません");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

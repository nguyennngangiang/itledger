import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { LoadingProvider } from "./hook/LoadingContext";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { ConfigProvider } from "antd";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#4f46e5",
          colorInfo: "#4f46e5",
          colorSuccess: "#16a34a",
          colorWarning: "#d97706",
          colorError: "#dc2626",
          colorTextBase: "#0f172a",
          borderRadius: 10,
          fontFamily:
            "'Inter', system-ui, 'Segoe UI', Roboto, sans-serif",
          controlHeight: 38,
        },
        components: {
          Table: {
            headerBg: "#f8fafc",
            headerColor: "#475569",
            headerSplitColor: "transparent",
            rowHoverBg: "#f5f3ff",
            borderColor: "#eef2f7",
            cellPaddingBlock: 14,
          },
          Button: {
            fontWeight: 600,
            primaryShadow: "none",
            defaultShadow: "none",
          },
          Modal: {
            borderRadiusLG: 16,
            titleFontSize: 18,
          },
          Input: { controlHeight: 38 },
          Select: { controlHeight: 38 },
        },
      }}
    >
      <LoadingProvider>
        <App />
        <ToastContainer position="top-right" autoClose={2500} newestOnTop />
      </LoadingProvider>
    </ConfigProvider>
  </StrictMode>,
);

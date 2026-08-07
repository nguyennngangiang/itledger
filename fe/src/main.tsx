import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { LoadingProvider } from "./hook/LoadingContext";
import { I18nProvider } from "./i18n/I18nProvider";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { ConfigProvider } from "antd";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#7c74e8",
          colorInfo: "#7c74e8",
          colorSuccess: "#16a34a",
          colorWarning: "#d97706",
          colorError: "#e05252",
          colorTextBase: "#2b2740",
          borderRadius: 10,
          fontFamily:
            "'Inter', system-ui, 'Segoe UI', Roboto, sans-serif",
          controlHeight: 38,
        },
        components: {
          Table: {
            headerBg: "#f3f1fc",
            headerColor: "#6b6785",
            headerSplitColor: "transparent",
            rowHoverBg: "#f6f4fe",
            borderColor: "#f0edf8",
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
        <I18nProvider>
          <App />
        </I18nProvider>
        <ToastContainer
          position="top-right"
          autoClose={2500}
          newestOnTop
          style={{ top: "74px" }}
        />
      </LoadingProvider>
    </ConfigProvider>
  </StrictMode>,
);

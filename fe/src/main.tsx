import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { NotFoundScreen } from "./components/NotFoundScreen";
import { LoadingProvider } from "./hook/LoadingProvider";
import { I18nProvider } from "./i18n/I18nProvider";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { ConfigProvider } from "antd";
import { watchFreshness } from "./lib/freshness";

watchFreshness();

// The real visible height, for browsers without `dvh` (iOS < 15.4, old Android
// WebViews): there `100vh` includes the area under the browser toolbars, so the
// bottom of every screen was cut off. App.css reads it as --app-h.
const setAppHeight = () =>
  document.documentElement.style.setProperty("--app-h", `${window.innerHeight}px`);
setAppHeight();
window.addEventListener("resize", setAppHeight);
window.addEventListener("orientationchange", setAppHeight);

// No router: the web server hands every path index.html, so anything but the root
// is a dead link and gets the 404 instead of the app.
const isRoot = ["/", "/index.html"].includes(window.location.pathname);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfigProvider
      theme={{
        token: {
          // --accent-solid: white text on it is 4.7:1; on #7c74e8 it was 3.8:1.
          colorPrimary: "#6b63dd",
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
          {isRoot ? <App /> : <NotFoundScreen />}
        </I18nProvider>
        <ToastContainer
          theme="light"
          position="top-right"
          autoClose={2500}
          newestOnTop
          style={{ top: "74px" }}
        />
      </LoadingProvider>
    </ConfigProvider>
  </StrictMode>,
);

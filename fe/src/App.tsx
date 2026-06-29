import "./App.css";

import { useState } from "react";
import loadingGif from "./assets/loading.gif";
import { useLoading } from "./hook/LoadingContext";
import { DeviceMainScreen } from "./components/DeviceMainScreen";
import { UserMainScreen } from "./components/UserMainScreen";

type ActiveMenu = "maintenance" | "handover" | "device" | "user" | null;

function App() {
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>(null);
  const { loading } = useLoading();

  return (
    <>
      {loading && (
        <div className="device-loading-overlay">
          <img
            src={loadingGif}
            alt="Loading devices…"
            style={{ width: "200px", height: "200px" }}
          />
        </div>
      )}
      <div className="app-layout">
        <div className="sidebar">
          <div className="sidebar-menu">
            <h2 className="sidebar-title">IT Ledger</h2>
            <button
              className="menu-button"
              onClick={() => setActiveMenu("device")}
            >
              💻 Devices
            </button>
            <button
              className="menu-button"
              onClick={() => setActiveMenu("user")}
            >
              👤 Users
            </button>
            <button
              className="menu-button"
              onClick={() => setActiveMenu("maintenance")}
            >
              🔧 Maintenance
            </button>
            <button
              className="menu-button"
              onClick={() => setActiveMenu("handover")}
            >
              🔄 Handover
            </button>
          </div>
        </div>
        <div className="main-content">
          {activeMenu === "device" && <DeviceMainScreen />}
          {activeMenu === "user" && <UserMainScreen />}
        </div>
      </div>
    </>
  );
}

export default App;

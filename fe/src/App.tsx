import "./App.css";

import { useEffect, useState } from "react";
import loadingGif from "./assets/loading.gif";
import { useLoading } from "./hook/LoadingContext";
// import "bootstrap/dist/css/bootstrap.min.css";
// import MaintenanceModal from "./components/MaintenanceModal";
// import HandoverModal from "./components/HandoverModal";
// import { CreateDeviceModal } from "./components/CreateDeviceModal";
// import { CreateUserModal } from "./components/CreateUserModal";
import { DeviceMainScreen } from "./components/DeviceMainScreen";
// import TableList from "./components/TableList";

// import { listDevices } from "./api/devices";
// import { listUsers } from "./api/users";
// import { listHandovers } from "./api/handovers";

// import type { Device, User, Handover } from "./types";

type ActiveMenu = "maintenance" | "handover" | "device" | "user" | null;

function App() {
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>(null);
  const { loading } = useLoading();
  console.log("loading", loading);
  // const [devices, setDevices] = useState<Device[]>([]);
  // const [users, setUsers] = useState<User[]>([]);
  // const [handovers, setHandovers] = useState<Handover[]>([]);

  // const loadData = async () => {
  //   try {
  //     const [deviceList, userList, handoverList] = await Promise.all([
  //       listDevices(),
  //       listUsers(),
  //       listHandovers(),
  //     ]);
  //     setDevices(deviceList);
  //     setUsers(userList);
  //     setHandovers(handoverList);
  //   } catch (err) {
  //     console.error(err);
  //   }
  // };

  // useEffect(() => {
  //   loadData();
  // }, []);

  // const closeModal = async () => {
  //   setActiveMenu(null);
  //   await loadData();
  // };

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
              💻 Device
            </button>
            <button
              className="menu-button"
              onClick={() => setActiveMenu("user")}
            >
              👤 Create User
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
        </div>
        {/* <TableList devices={devices} handovers={handovers} users={users} /> */}
      </div>

      {/* {activeMenu === "maintenance" && (
        <MaintenanceModal onClose={closeModal} />
      )}
      {activeMenu === "handover" && <HandoverModal onClose={closeModal} />}
      {activeMenu === "device" && <CreateDeviceModal onClose={closeModal} />}
      {activeMenu === "user" && <CreateUserModal onClose={closeModal} />} */}
    </>
  );
}

export default App;

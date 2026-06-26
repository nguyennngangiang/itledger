import { useState, useEffect } from "react";
import { listDevices } from "../api/devices";
import type { Device } from "../types";
import { useLoading } from "../hook/LoadingContext";

export const DeviceMainScreen = () => {
  const [devices, setDevices] = useState<Device[]>([]);
  const { startLoading, endLoading } = useLoading();

  const loadDevices = async () => {
    startLoading();
    try {
      const deviceList = await listDevices();
      setDevices(deviceList);
    } catch (err) {
      console.error(err);
    } finally {
      setTimeout(() => {
        endLoading();
      }, 1000);
    }
  };

  useEffect(() => {
    if (devices.length === 0) {
      loadDevices();
    }
  }, []);

  return (
    <>
      <div>
        <div className="menu-title">Device List</div>
        <div className="device-table-container">
          <table className="device-table">
            <thead>
              <tr>
                <th>Serial Number</th>
                <th>Device Name</th>
                <th>Brand</th>
                <th>CPU</th>
                <th>RAM</th>
                <th>Storage</th>
                <th>OS</th>
                <th>MS Office</th>
                <th>Buy Date</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => {
                return (
                  <tr key={device.serial_number}>
                    <td>{device.serial_number}</td>
                    <td>{device.name}</td>
                    <td>{device.brand}</td>
                    <td>{device.cpu}</td>
                    <td>{device.ram}</td>
                    <td>{device.storage}</td>
                    <td>{device.os}</td>
                    <td>{device.msoffice}</td>
                    <td>{device.buy_date}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};

import './App.css'

import { useEffect, useState } from 'react'
import MaintenanceModal from './components/MaintenanceModal'
import HandoverModal from './components/HandoverModal'
import { CreateDeviceModal } from './components/CreateDeviceModal'
import { CreateUserModal } from './components/CreateUserModal'

import { listDevices } from './api/devices'
import { listUsers } from './api/users'
import { listHandovers } from './api/handovers'

import type { Device, User, Handover } from './types'

type ActiveModal = 'maintenance' | 'handover' | 'device' | 'user' | null

function App() {
  const [activeModal, setActiveModal] = useState<ActiveModal>(null)

  const [devices, setDevices] = useState<Device[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [handovers, setHandovers] = useState<Handover[]>([])

  const loadData = async () => {
    try {
      const [deviceList, userList, handoverList] = await Promise.all([
        listDevices(),
        listUsers(),
        listHandovers(),
      ])

      setDevices(deviceList)
      setUsers(userList)
      setHandovers(handoverList)
    } catch (err) {
      console.error(err)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  const closeModal = async () => {
    setActiveModal(null)
    await loadData()
  }

  return (
  <>
    <div className="app-layout">
      <div className="sidebar">
        <div className="sidebar-menu">
  <h2 className="sidebar-title">IT Ledger</h2>

  <button
    className="menu-button"
    onClick={() => setActiveModal('device')}
  >
    💻 Create Device
  </button>

  <button
    className="menu-button"
    onClick={() => setActiveModal('user')}
  >
    👤 Create User
  </button>

  <button
    className="menu-button"
    onClick={() => setActiveModal('maintenance')}
  >
    🔧 Maintenance
  </button>

  <button
    className="menu-button"
    onClick={() => setActiveModal('handover')}
  >
    🔄 Handover
  </button>
</div>
      </div>

      <div className="main-content">
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
                <th>Employee Code</th>
                <th>Employee Name</th>
                <th>Team</th>
              </tr>
            </thead>

            <tbody>
              {devices.map((device) => {
                const deviceHandovers = handovers.filter(
                  (handover) => handover.device_id === device.serial_number
                )

                const latestHandover =
                  deviceHandovers.length > 0
                    ? deviceHandovers[deviceHandovers.length - 1]
                    : undefined

                const owner = users.find(
                  (user) =>
                    user.employee_code === latestHandover?.to_user_id
                )

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

                    <td>{owner?.employee_code ?? ''}</td>
                    <td>{owner?.name ?? ''}</td>
                    <td>{owner?.team ?? ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    {activeModal === 'maintenance' && (
      <MaintenanceModal onClose={closeModal} />
    )}

    {activeModal === 'handover' && (
      <HandoverModal onClose={closeModal} />
    )}

    {activeModal === 'device' && (
      <CreateDeviceModal onClose={closeModal} />
    )}

    {activeModal === 'user' && (
      <CreateUserModal onClose={closeModal} />
    )}
  </>
)
}

export default App
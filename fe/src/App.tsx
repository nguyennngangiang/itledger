import './App.css'

import { useEffect, useState } from 'react'
import MaintenanceModal from './components/MaintenanceModal'
import HandoverModal from './components/HandoverModal'
import { CreateDeviceModal } from './components/CreateDeviceModal'
import { CreateUserModal } from './components/CreateUserModal'
import TableList from './components/TableList'

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
        <TableList devices={devices} handovers={handovers} users={users} />
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

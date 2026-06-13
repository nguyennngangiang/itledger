import './App.css'

import { useState } from 'react'
import MaintenanceModal from './components/MaintenanceModal'
import HandoverModal from './components/HandoverModal'
import { CreateDeviceModal } from './components/CreateDeviceModal'
import { CreateUserModal } from './components/CreateUserModal'

type ActiveModal = 'maintenance' | 'handover' | 'device' | 'user' | null

function App() {
  const [activeModal, setActiveModal] = useState<ActiveModal>(null)

  const closeModal = () => setActiveModal(null)

  return (
    <>
      <div className="home-actions">
      <button type="button" onClick={() => setActiveModal('device')}>
          Create Device
        </button>
        <button type="button" onClick={() => setActiveModal('user')}>
          Create User
        </button>
        <button type="button" onClick={() => setActiveModal('maintenance')}>
          Maintenance
        </button>
        <button type="button" onClick={() => setActiveModal('handover')}>
          Handover
        </button>

      </div>

      {activeModal === 'maintenance' && <MaintenanceModal onClose={closeModal} />}
      {activeModal === 'handover' && <HandoverModal onClose={closeModal} />}
      {activeModal === 'device' && <CreateDeviceModal onClose={closeModal} />}
      {activeModal === 'user' && <CreateUserModal onClose={closeModal} />}
    </>
  )
}

export default App

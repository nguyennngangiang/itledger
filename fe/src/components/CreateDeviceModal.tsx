import { useState } from 'react'
import { createDevice } from '../api/devices'
import { ApiError } from '../api/client'
import type { DeviceCreate } from '../types'
import { Modal } from './Modal'

function emptyToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export function CreateDeviceModal({ onClose }: { onClose: () => void }) {
  const [serialNumber, setSerialNumber] = useState('')
  const [barcode, setBarcode] = useState('')
  const [type, setType] = useState('')
  const [brand, setBrand] = useState('')
  const [cpu, setCpu] = useState('')
  const [ram, setRam] = useState('')
  const [storage, setStorage] = useState('')
  const [os, setOs] = useState('')
  const [msoffice, setMsoffice] = useState('')
  const [buyDate, setBuyDate] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setSubmitting(true)

    const device: DeviceCreate = {
      serial_number: serialNumber.trim(),
      barcode: emptyToNull(barcode),
      type: emptyToNull(type),
      brand: emptyToNull(brand),
      cpu: emptyToNull(cpu),
      ram: emptyToNull(ram),
      storage: emptyToNull(storage),
      os: emptyToNull(os),
      msoffice: emptyToNull(msoffice),
      buy_date: emptyToNull(buyDate),
      name: emptyToNull(name),
    }

    try {
      await createDevice(device)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? String(err.message) : 'Failed to create device')
    } finally {
      setSubmitting(false)
    }
  }

  return (
  <Modal title="Create Device" onClose={onClose}>
    <form className="device-form" onSubmit={handleSubmit}>
      <div className="device-grid">
        <label>
          Serial Number *
          <input
            type="text"
            value={serialNumber}
            onChange={(e) => setSerialNumber(e.target.value)}
            required
            placeholder="SN123456789"
          />
        </label>

        <label>
          Barcode
          <input
            type="text"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            placeholder="Barcode"
          />
        </label>

        <label>
          Device Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Dell Latitude 5420"
          />
        </label>

        <label>
          Type
          <input
            type="text"
            value={type}
            onChange={(e) => setType(e.target.value)}
            placeholder="Laptop"
          />
        </label>

        <label>
          Brand
          <input
            type="text"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            placeholder="Dell"
          />
        </label>

        <label>
          CPU
          <input
            type="text"
            value={cpu}
            onChange={(e) => setCpu(e.target.value)}
            placeholder="Intel Core i5"
          />
        </label>

        <label>
          RAM
          <input
            type="text"
            value={ram}
            onChange={(e) => setRam(e.target.value)}
            placeholder="16 GB"
          />
        </label>

        <label>
          Storage
          <input
            type="text"
            value={storage}
            onChange={(e) => setStorage(e.target.value)}
            placeholder="512 GB SSD"
          />
        </label>

        <label>
          Operating System
          <input
            type="text"
            value={os}
            onChange={(e) => setOs(e.target.value)}
            placeholder="Windows 11"
          />
        </label>

        <label>
          MS Office
          <input
            type="text"
            value={msoffice}
            onChange={(e) => setMsoffice(e.target.value)}
            placeholder="Office 365"
          />
        </label>

        <label>
          Buy Date
          <input
            type="date"
            value={buyDate}
            onChange={(e) => setBuyDate(e.target.value)}
          />
        </label>
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="device-actions">
        <button
          type="button"
          className="cancel-btn"
          onClick={onClose}
          disabled={submitting}
        >
          Cancel
        </button>

        <button
          type="submit"
          className="create-btn"
          disabled={submitting}
        >
          {submitting ? 'Creating...' : 'Create Device'}
        </button>
      </div>
    </form>
  </Modal>
)
}

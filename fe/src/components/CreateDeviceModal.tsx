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
      <form className="modal-form" onSubmit={handleSubmit}>
        <label>
          Serial number
          <input
            type="text"
            value={serialNumber}
            onChange={(e) => setSerialNumber(e.target.value)}
            required
          />
        </label>
        <label>
          Barcode
          <input
            type="text"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
          />
        </label>
        <label>
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Type
          <input
            type="text"
            value={type}
            onChange={(e) => setType(e.target.value)}
          />
        </label>
        <label>
          Brand
          <input
            type="text"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
          />
        </label>
        <label>
          CPU
          <input
            type="text"
            value={cpu}
            onChange={(e) => setCpu(e.target.value)}
          />
        </label>
        <label>
          RAM
          <input
            type="text"
            value={ram}
            onChange={(e) => setRam(e.target.value)}
          />
        </label>
        <label>
          Storage
          <input
            type="text"
            value={storage}
            onChange={(e) => setStorage(e.target.value)}
          />
        </label>
        <label>
          OS
          <input
            type="text"
            value={os}
            onChange={(e) => setOs(e.target.value)}
          />
        </label>
        <label>
          MS Office
          <input
            type="text"
            value={msoffice}
            onChange={(e) => setMsoffice(e.target.value)}
          />
        </label>
        <label>
          Buy date
          <input
            type="date"
            value={buyDate}
            onChange={(e) => setBuyDate(e.target.value)}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

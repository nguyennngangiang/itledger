import { useEffect, useState } from 'react'
import { listDevices } from '../api/devices'
import { createMaintenance } from '../api/maintenance'
import { listTeams } from '../api/teams'
import { ApiError } from '../api/client'
import type { Device, MaintenanceCreate, Team } from '../types'
import { Modal } from './Modal'

function emptyToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function MaintenanceModal({ onClose }: { onClose: () => void }) {
  const [serialNumber, setSerialNumber] = useState('')
  const [teamId, setTeamId] = useState('')
  const [part, setPart] = useState('')
  const [problem, setProblem] = useState('')
  const [solution, setSolution] = useState('')
  const [result, setResult] = useState('')
  const [cost, setCost] = useState('')
  const [remark, setRemark] = useState('')
  const [devices, setDevices] = useState<Device[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    Promise.all([listDevices(), listTeams()])
      .then(([deviceList, teamList]) => {
        setDevices(deviceList)
        setTeams(teamList)
      })
      .catch((err) => {
        setLoadError(
          err instanceof ApiError ? String(err.message) : 'Failed to load form data'
        )
      })
      .finally(() => setLoading(false))
  }, [])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setSubmitting(true)

    const costTrimmed = cost.trim()
    let costVnd: number | null = null
    if (costTrimmed !== '') {
      const parsed = Number(costTrimmed)
      if (Number.isNaN(parsed)) {
        setError('Cost must be a number')
        setSubmitting(false)
        return
      }
      costVnd = parsed
    }

    const maintenance: MaintenanceCreate = {
      maintenance_id: crypto.randomUUID(),
      maintenance_date: todayIsoDate(),
      device_id: serialNumber,
      team: teamId,
      part: emptyToNull(part),
      reason: emptyToNull(problem),
      solution: emptyToNull(solution),
      result: emptyToNull(result),
      cost_vnd: costVnd,
      remarks: emptyToNull(remark),
    }

    try {
      await createMaintenance(maintenance)
      onClose()
    } catch (err) {
      setError(
        err instanceof ApiError ? String(err.message) : 'Failed to submit maintenance'
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
  <Modal title="Maintenance" onClose={onClose}>
    <form className="modal-form maintenance-form" onSubmit={handleSubmit}>
      <div className="maintenance-grid">
        <label>
          Device serial number
          <select
            value={serialNumber}
            onChange={(e) => setSerialNumber(e.target.value)}
            required
            disabled={loading || !!loadError || submitting}
          >
            <option value="">
              {loading
                ? 'Loading devices…'
                : loadError
                  ? 'Could not load devices'
                  : 'Select a device'}
            </option>
            {devices.map((device) => (
              <option key={device.serial_number} value={device.serial_number}>
                {device.serial_number}
                {device.name ? ` — ${device.name}` : ''}
              </option>
            ))}
          </select>
        </label>

        <label>
          Team
          <select
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            required
            disabled={loading || !!loadError || submitting}
          >
            <option value="">
              {loading
                ? 'Loading teams…'
                : loadError
                  ? 'Could not load teams'
                  : 'Select a team'}
            </option>
            {teams.map((team) => (
              <option key={team.team_id} value={team.team_id}>
                {team.team_id}
                {team.team_name ? ` — ${team.team_name}` : ''}
              </option>
            ))}
          </select>
        </label>

        <label>
          Part that needs to be repair
          <input
            type="text"
            value={part}
            onChange={(e) => setPart(e.target.value)}
            disabled={submitting}
          />
        </label>

        <label>
          Description of the problem
          <input
            type="text"
            value={problem}
            onChange={(e) => setProblem(e.target.value)}
            disabled={submitting}
          />
        </label>

        <label>
          Solution of the problem
          <input
            type="text"
            value={solution}
            onChange={(e) => setSolution(e.target.value)}
            disabled={submitting}
          />
        </label>

        <label>
          Result of the repair
          <input
            type="text"
            value={result}
            onChange={(e) => setResult(e.target.value)}
            disabled={submitting}
          />
        </label>

        <label>
          Cost of the repair
          <input
            type="text"
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            disabled={submitting}
          />
        </label>

        <label>
          Remark
          <input
            type="text"
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            disabled={submitting}
          />
        </label>
      </div>

      {loadError && <p className="form-error">{loadError}</p>}
      {error && <p className="form-error">{error}</p>}

      <div className="modal-actions">
        <button
          className="cancel-btn"
          type="button"
          onClick={onClose}
          disabled={submitting}
        >
          Cancel
        </button>

        <button
          className="create-btn"
          type="submit"
          disabled={loading || !!loadError || submitting}
        >
          {submitting ? 'Submitting…' : 'Submit'}
        </button>
      </div>
    </form>
  </Modal>
)
}

export default MaintenanceModal

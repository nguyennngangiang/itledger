import { useEffect, useState } from 'react'
import { createUser } from '../api/users'
import { listTeams } from '../api/teams'
import { ApiError } from '../api/client'
import type { Team, UserCreate } from '../types'
import { Modal } from './Modal'

function emptyToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export function CreateUserModal({ onClose }: { onClose: () => void }) {
  const [employeeCode, setEmployeeCode] = useState('')
  const [name, setName] = useState('')
  const [team, setTeam] = useState('')
  const [teams, setTeams] = useState<Team[]>([])
  const [loadingTeams, setLoadingTeams] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    listTeams()
      .then(setTeams)
      .catch((err) => {
        setLoadError(
          err instanceof ApiError ? String(err.message) : 'Failed to load teams'
        )
      })
      .finally(() => setLoadingTeams(false))
  }, [])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setSubmitting(true)

    const user: UserCreate = {
      employee_code: employeeCode.trim(),
      name: name.trim(),
      team: emptyToNull(team),
    }

    try {
      await createUser(user)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? String(err.message) : 'Failed to create user')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal title="Create User" onClose={onClose}>
      <form className="modal-form" onSubmit={handleSubmit}>
        <label>
          Employee code
          <input
            type="text"
            value={employeeCode}
            onChange={(e) => setEmployeeCode(e.target.value)}
            required
            disabled={submitting}
          />
        </label>
        <label>
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            disabled={submitting}
          />
        </label>
        <label>
          Team
          <select
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            disabled={submitting || loadingTeams || !!loadError}
          >
            <option value="">
              {loadingTeams
                ? 'Loading teams…'
                : loadError
                  ? 'Could not load teams'
                  : 'Select a team (optional)'}
            </option>
            {teams.map((t) => (
              <option key={t.team_id} value={t.team_id}>
                {t.team_id}
                {t.team_name ? ` — ${t.team_name}` : ''}
              </option>
            ))}
          </select>
        </label>
        {loadError && <p className="form-error">{loadError}</p>}
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" disabled={submitting || loadingTeams || !!loadError}>
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

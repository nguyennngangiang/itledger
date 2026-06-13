import { request } from './client'
import type { Team } from '../types'

export function listTeams() {
  return request<Team[]>('/teams')
}

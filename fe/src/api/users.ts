import { request } from './client'
import type { User, UserCreate, UserCreateBatch } from '../types'
import { pageQuery } from './paging'
import type { Paged, PageParams } from './paging'

export function listUsers(team?: string) {
  const query = team ? `?team=${encodeURIComponent(team)}` : ''
  return request<User[]>(`/users${query}`)
}

/**
 * Active staff PLUS anyone in the trash — for the tables' name lookup maps.
 *
 * A handover from two years ago still names whoever held the device; once that
 * person leaves and is trashed, `listUsers()` drops them and the row falls back
 * to a bare employee code. Use this wherever the map only *displays* names.
 * Owner pickers deliberately keep `listUsers()`: a device must not be handed to
 * someone who has left.
 */
export function listUsersIncludingDeleted() {
  return request<User[]>('/users?include_deleted=true')
}

export function pageUsers(params: PageParams) {
  return request<Paged<User>>(`/users/page?${pageQuery(params)}`)
}

// Team names actually present in the data. There is no teams table, so this
// (not a hardcoded list) is the real source for the team autocomplete.
export function listUserTeams() {
  return request<string[]>('/users/teams')
}

export function getUser(employeeCode: string) {
  return request<User>(`/users/${encodeURIComponent(employeeCode)}`)
}

export function searchUser(q: string) {
  return request<User[]>(`/users/search?q=${encodeURIComponent(q)}`)
}

export function createUser(user: UserCreate) {
  return request<User>('/users', {
    method: 'POST',
    body: JSON.stringify(user),
  })
}

export function createUserBatch(users: UserCreateBatch) {
  return request<User[]>('/users/batch', {
    method: 'POST',
    body: JSON.stringify(users),
  })
}

export function updateUser(employeeCode: string, patch: Partial<User>) {
  return request<User>(`/users/${encodeURIComponent(employeeCode)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function restoreUser(employeeCode: string) {
  return request<User>('/users/restore', {
    method: 'POST',
    body: JSON.stringify({ employee_code: employeeCode }),
  })
}

// DELETE /users takes the code in the body, not the path (same shape as
// deleteDevice). Hitting /users/<code> returns 405 — there is no such route.
// Soft-delete by default; `permanent` purges from the trash. The backend
// refuses (409) for IT-STORE or anyone still holding devices.
export function deleteUser(employeeCode: string, permanent = false) {
  return request<void>(`/users${permanent ? '?permanent=true' : ''}`, {
    method: 'DELETE',
    body: JSON.stringify({ employee_code: employeeCode }),
  })
}

// Bulk delete by employee code (soft-delete, or purge when permanent).
export function deleteUsersBatch(codes: string[], permanent = false) {
  return request<void>(`/users/batch${permanent ? '?permanent=true' : ''}`, {
    method: 'DELETE',
    body: JSON.stringify(codes),
  })
}
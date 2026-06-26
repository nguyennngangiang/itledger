import { request } from './client'
import type { User, UserCreate, UserCreateBatch } from '../types'

export function listUsers(team?: string) {
  const query = team ? `?team=${encodeURIComponent(team)}` : ''
  return request<User[]>(`/users${query}`)
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
  return request<User>('/users/batch', {
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

export function deleteUser(employeeCode: string) {
  return request<void>(`/users/${encodeURIComponent(employeeCode)}`, {
    method: 'DELETE',
  })
}
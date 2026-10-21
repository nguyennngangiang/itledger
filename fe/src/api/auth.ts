// Login for the single shared admin account — see be/auth.py.
import { request } from './client'

export function login(username: string, password: string) {
  return request<{ token: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

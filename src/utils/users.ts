import type { RoomUser } from '../types.ts'

const users: RoomUser[] = []

export interface AddUserResult {
  error?: string
  user?: RoomUser
}

export const addUser = ({ id, username, room }: RoomUser): AddUserResult => {
  username = username.trim().toLowerCase()
  room = room.trim().toLowerCase()

  if (!username || !room) {
    return { error: 'Username and Room are required!' }
  }

  const taken = users.some((user) => user.room === room && user.username === username)

  if (taken) {
    return { error: 'Username is in use!' }
  }

  const user = { id, username, room }
  users.push(user)
  return { user }
}

export const removeUser = (id: string): RoomUser | undefined => {
  const index = users.findIndex((user) => user.id === id)
  // guard: splice(-1) would remove the last user in the list
  return index === -1 ? undefined : users.splice(index, 1)[0]
}

export const getUser = (id: string): RoomUser | undefined => users.find((user) => user.id === id)

export const getUsersInRoom = (room: string): RoomUser[] => {
  const normalized = room.trim().toLowerCase()
  return users.filter((user) => user.room === normalized)
}

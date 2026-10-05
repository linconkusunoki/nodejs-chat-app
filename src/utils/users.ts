import type { RoomUser } from '../types.ts'

const users: RoomUser[] = []

export interface AddUserResult {
  error?: string
  user?: RoomUser
}

export const addUser = ({ id, username, room }: RoomUser): AddUserResult => {
  const name = username.trim().toLowerCase()
  const normalizedRoom = room.trim().toLowerCase()

  if (!name || !normalizedRoom) {
    return { error: 'Username and Room are required!' }
  }

  // Drop any earlier entry for this socket. After a recovered reconnect the id
  // can be unchanged, and a second entry would leave a ghost in the sidebar
  // that removeUser would never clean up.
  const existing = users.findIndex((user) => user.id === id)
  const previous = existing === -1 ? undefined : users.splice(existing, 1)[0]

  if (users.some((user) => user.room === normalizedRoom && user.username === name)) {
    // Rejoining under a name someone else holds must not evict their session.
    if (previous) users.push(previous)
    return { error: 'Username is in use!' }
  }

  const user = { id, username: name, room: normalizedRoom }
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

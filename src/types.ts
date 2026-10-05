export interface RoomUser {
  id: string
  username: string
  room: string
}

export interface RoomUserView {
  username: string
}

export interface Reaction {
  emoji: string
  usernames: string[]
}

export interface ChatMessage {
  id: string
  username: string
  text: string
  createdAt: number
  editedAt?: number
  reactions?: Reaction[]
}

export interface RoomData {
  room: string
  users: RoomUserView[]
  // Sent to the client so the composer's maxlength and counter cannot drift
  // from the limit the server actually enforces.
  maxMessageLength: number
}

export type AckError = string | undefined

export const MAX_MESSAGE_LENGTH = 1000

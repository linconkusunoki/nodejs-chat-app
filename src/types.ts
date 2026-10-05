export interface RoomUser {
  id: string
  username: string
  room: string
}

export interface RoomUserView {
  username: string
}

export interface ChatMessage {
  username: string
  text: string
  createdAt: number
}

export interface RoomData {
  room: string
  users: RoomUserView[]
}

export type AckError = string | undefined

export const MAX_MESSAGE_LENGTH = 1000

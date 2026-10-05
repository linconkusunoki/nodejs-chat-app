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
  // The reaction picker is built from this, so the client can never offer an
  // emoji the server would then reject.
  reactions: readonly string[]
}

export type AckError = string | undefined

export const MAX_MESSAGE_LENGTH = 1000

export const REACTION_EMOJI = ['👍', '❤️', '😂', '🎉', '😮', '😢'] as const

export type ReactionEmoji = (typeof REACTION_EMOJI)[number]

export const isReactionEmoji = (value: unknown): value is ReactionEmoji =>
  typeof value === 'string' && (REACTION_EMOJI as readonly string[]).includes(value)

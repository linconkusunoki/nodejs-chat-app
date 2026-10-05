import { randomUUID } from 'node:crypto'
import type { ChatMessage } from '../types.ts'

export const MAX_ROOM_HISTORY = 100

const rooms = new Map<string, ChatMessage[]>()

export const generateMessage = (username: string, text: string): ChatMessage => ({
  id: randomUUID(),
  text,
  username,
  createdAt: Date.now(),
})

export const addMessage = (room: string, message: ChatMessage): void => {
  const history = rooms.get(room) ?? []
  history.push(message)
  if (history.length > MAX_ROOM_HISTORY) {
    history.splice(0, history.length - MAX_ROOM_HISTORY)
  }
  rooms.set(room, history)
}

export const getRoomHistory = (room: string): ChatMessage[] => rooms.get(room) ?? []

export const findMessage = (room: string, id: string): ChatMessage | undefined =>
  rooms.get(room)?.find((message) => message.id === id)

export const updateMessage = (room: string, id: string, text: string): ChatMessage | undefined => {
  const message = findMessage(room, id)
  if (!message) return undefined
  message.text = text
  message.editedAt = Date.now()
  return message
}

export const removeMessage = (room: string, id: string): ChatMessage | undefined => {
  const history = rooms.get(room)
  if (!history) return undefined
  const index = history.findIndex((message) => message.id === id)
  return index === -1 ? undefined : history.splice(index, 1)[0]
}

// Toggling rather than adding: reacting twice takes the reaction back, and an
// emoji nobody has reacted with disappears from the row instead of lingering
// as a permanent "0".
export const toggleReaction = (message: ChatMessage, emoji: string, username: string): void => {
  const reactions = (message.reactions ??= [])
  const existing = reactions.find((reaction) => reaction.emoji === emoji)

  if (!existing) {
    reactions.push({ emoji, usernames: [username] })
    return
  }

  const index = existing.usernames.indexOf(username)
  if (index === -1) existing.usernames.push(username)
  else existing.usernames.splice(index, 1)

  if (!existing.usernames.length) reactions.splice(reactions.indexOf(existing), 1)
}

// ponytail: room keys are never evicted, so a hostile client can grow this map
// by joining many distinct rooms. Evict on empty + LRU cap if that matters.

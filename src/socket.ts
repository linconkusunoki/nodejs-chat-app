import { Server } from 'socket.io'
import { Filter } from 'bad-words'
import { addUser, getUser, getUsersInRoom, removeUser } from './utils/users.ts'
import {
  addMessage,
  findMessage,
  generateMessage,
  getRoomHistory,
  removeMessage,
  toggleReaction,
  updateMessage,
} from './utils/messages.ts'
import { isReactionEmoji, MAX_MESSAGE_LENGTH, REACTION_EMOJI } from './types.ts'
import type { RoomUser } from './types.ts'

const filter = new Filter()

const roomPayload = (room: string) => ({
  room,
  users: getUsersInRoom(room).map(({ username }) => ({ username })),
  maxMessageLength: MAX_MESSAGE_LENGTH,
  reactions: REACTION_EMOJI,
})

// Only user messages are replayed to newcomers: system lines ("x has left")
// refer to a presence that already changed, so replaying them is just noise.
const broadcast = (io: Server, room: string, username: string, text: string) => {
  const message = generateMessage(username, text)
  addMessage(room, message)
  io.to(room).emit('message', message)
  return message
}

// Shared by sendMessage and editMessage so the rules cannot drift apart: an
// edit has to be held to the same length and profanity limits as an original.
const validateText = (text: string): string | undefined => {
  if (!text) return 'Message cannot be empty!'
  if (text.length > MAX_MESSAGE_LENGTH) {
    return `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer!`
  }
  if (filter.isProfane(text)) return 'Profanity is not allowed!'
  return undefined
}

// Only the message's own author may change it. The room lookup scopes the id,
// and this check scopes the change within that room.
const findOwnMessage = (user: RoomUser, id: unknown) => {
  if (typeof id !== 'string') return undefined
  const message = findMessage(user.room, id)
  return message?.username === user.username ? message : undefined
}

export const registerSocketHandlers = (io: Server) => {
  io.on('connection', (socket) => {
    // Every event needs the sender to still be in a room; without this a
    // disconnect race throws and takes the whole process down.
    const requireUser = (): RoomUser | undefined => getUser(socket.id)

    socket.on('join', (payload: unknown, ack?: (error?: string) => void) => {
      const { username, room } = (payload ?? {}) as {
        username?: string
        room?: string
      }
      const result = addUser({
        id: socket.id,
        username: username ?? '',
        room: room ?? '',
      })

      if (result.error || !result.user) {
        ack?.(result.error ?? 'Could not join room!')
        return
      }

      const { user } = result
      socket.join(user.room)

      for (const message of getRoomHistory(user.room)) socket.emit('message', message)
      socket.emit('message', generateMessage('Admin', 'Welcome'))
      socket.broadcast
        .to(user.room)
        .emit('message', generateMessage('Admin', `${user.username} has joined!`))

      io.to(user.room).emit('roomData', roomPayload(user.room))

      ack?.()
    })

    socket.on('sendMessage', (message: unknown, ack?: (error?: string) => void) => {
      const user = requireUser()
      if (!user) return ack?.('You are not in a room!')

      const text = typeof message === 'string' ? message.trim() : ''
      const error = validateText(text)
      if (error) return ack?.(error)

      broadcast(io, user.room, user.username, text)
      ack?.()
    })

    socket.on('editMessage', (payload: unknown, ack?: (error?: string) => void) => {
      const user = requireUser()
      if (!user) return ack?.('You are not in a room!')

      const { id, text: raw } = (payload ?? {}) as { id?: string; text?: string }
      const message = findOwnMessage(user, id)
      if (!message) return ack?.('You can only edit your own messages!')

      const text = typeof raw === 'string' ? raw.trim() : ''
      const error = validateText(text)
      if (error) return ack?.(error)

      updateMessage(user.room, message.id, text)
      io.to(user.room).emit('messageUpdated', message)
      ack?.()
    })

    socket.on('deleteMessage', (payload: unknown, ack?: (error?: string) => void) => {
      const user = requireUser()
      if (!user) return ack?.('You are not in a room!')

      const { id } = (payload ?? {}) as { id?: string }
      const message = findOwnMessage(user, id)
      if (!message) return ack?.('You can only delete your own messages!')

      removeMessage(user.room, message.id)
      io.to(user.room).emit('messageDeleted', { id: message.id })
      ack?.()
    })

    socket.on('toggleReaction', (payload: unknown, ack?: (error?: string) => void) => {
      const user = requireUser()
      if (!user) return ack?.('You are not in a room!')

      const { id, emoji } = (payload ?? {}) as { id?: string; emoji?: string }

      // The emoji list is a trust boundary: a client can send any string here,
      // so it is checked against the allowlist rather than stored as-is.
      if (typeof id !== 'string' || !isReactionEmoji(emoji)) {
        return ack?.('Unknown reaction!')
      }

      const message = findMessage(user.room, id)
      if (!message) return ack?.('That message is no longer available!')

      toggleReaction(message, emoji, user.username)
      io.to(user.room).emit('messageUpdated', message)
      ack?.()
    })

    socket.on('userTyping', () => {
      const user = requireUser()
      if (!user) return
      // toOthers, not to(): the typist already knows they are typing.
      socket.to(user.room).emit('userTyping', { username: user.username })
    })

    socket.on('disconnect', () => {
      const user = removeUser(socket.id)
      if (!user) return

      io.to(user.room).emit('message', generateMessage('Admin', `${user.username} has left`))
      io.to(user.room).emit('roomData', roomPayload(user.room))
    })
  })
}

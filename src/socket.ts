import { Server } from 'socket.io'
import { Filter } from 'bad-words'
import { addUser, getUser, getUsersInRoom, removeUser } from './utils/users.ts'
import { generateMessage } from './utils/messages.ts'
import { MAX_MESSAGE_LENGTH } from './types.ts'
import type { RoomUser } from './types.ts'

const filter = new Filter()

const roomPayload = (room: string) => ({
  room,
  users: getUsersInRoom(room).map(({ username }) => ({ username })),
})

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
      if (!text) return ack?.('Message cannot be empty!')
      if (text.length > MAX_MESSAGE_LENGTH)
        return ack?.(`Message must be ${MAX_MESSAGE_LENGTH} characters or fewer!`)
      if (filter.isProfane(text)) return ack?.('Profanity is not allowed!')

      io.to(user.room).emit('message', generateMessage(user.username, text))
      ack?.()
    })

    socket.on('disconnect', () => {
      const user = removeUser(socket.id)
      if (!user) return

      io.to(user.room).emit('message', generateMessage('Admin', `${user.username} has left`))
      io.to(user.room).emit('roomData', roomPayload(user.room))
    })
  })
}

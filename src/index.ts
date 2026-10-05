import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { createApp } from './app.ts'
import { registerSocketHandlers } from './socket.ts'

const port = Number(process.env.PORT) || 3000

const server = createServer(createApp())

// Survives a brief drop (Render's free tier wakes, a tunnel blips): the socket
// id, its rooms and its missed packets come back. The presence store is
// application state rather than Socket.IO state, so socket.ts restores that
// from socket.data on a recovered connection.
const io = new Server(server, {
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
})

registerSocketHandlers(io)

// Render sends SIGTERM on deploy and instance replacement; without this the
// process is killed mid-handshake.
const shutdown = (signal: string) => {
  console.log(`${signal} received, shutting down`)
  io.close(() => server.close(() => process.exit(0)))
  setTimeout(() => process.exit(0), 10000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// log, don't die: one bad message shouldn't take the chat down for everyone
process.on('unhandledRejection', (reason) => console.error('unhandled rejection:', reason))
process.on('uncaughtException', (err) => console.error('uncaught:', err))

server.on('error', (err) => console.error('server error:', err))

server.listen(port, '0.0.0.0', () =>
  console.log(`Server is running up on http://localhost:${port}`)
)

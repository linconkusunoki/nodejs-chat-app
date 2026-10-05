import { test, before, after } from 'node:test'
import assert from 'node:assert'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { io as ioClient, type Socket } from 'socket.io-client'
import type { ChatMessage, RoomData } from '../src/types.ts'

const PORT = 4123
const URL = `http://localhost:${PORT}`
const here = path.dirname(fileURLToPath(import.meta.url))

let server: ChildProcess

const startServer = () =>
  new Promise<void>((resolve, reject) => {
    server = spawn('npm', ['run', '--silent', 'start'], {
      cwd: path.join(here, '..'),
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    server.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Server is running up')) resolve()
    })
    server.on('exit', (code) => reject(new Error(`server exited: ${code}`)))
    setTimeout(() => reject(new Error('server did not start in 10s')), 10000)
  })

const connect = () =>
  new Promise<Socket>((resolve, reject) => {
    const socket = ioClient(URL, { forceNew: true, reconnection: false })
    socket.on('connect', () => resolve(socket))
    socket.on('connect_error', reject)
  })

const emit = (socket: Socket, event: string, payload?: unknown) =>
  new Promise<string | undefined>((resolve, reject) => {
    socket.emit(event, payload, (response: string | undefined) => resolve(response))
    setTimeout(() => reject(new Error(`no ack for '${event}'`)), 5000)
  })

const emitError = async (socket: Socket, event: string, payload?: unknown) => {
  const error = await emit(socket, event, payload)
  assert.ok(error, `expected '${event}' to be rejected`)
  return error
}

const nextEvent = <T>(socket: Socket, event: string) =>
  new Promise<T>((resolve, reject) => {
    socket.once(event, (payload: T) => resolve(payload))
    setTimeout(() => reject(new Error(`no '${event}' received`)), 5000)
  })

before(startServer)
after(() => server?.kill())

test('a message reaches everyone in the room', async (t) => {
  const alice = await connect()
  const bob = await connect()
  t.after(() => [alice, bob].forEach((s) => s.close()))

  await emit(alice, 'join', { username: 'alice', room: 'js' })
  await emit(bob, 'join', { username: 'bob', room: 'js' })

  const received = nextEvent<ChatMessage>(bob, 'message')
  await emit(alice, 'sendMessage', 'hello')

  assert.strictEqual((await received).text, 'hello')
})

test('roomData lists every member of the room', async (t) => {
  const alice = await connect()
  t.after(() => alice.close())

  const received = nextEvent<RoomData>(alice, 'roomData')
  await emit(alice, 'join', { username: 'alice', room: 'css' })

  const { room, users } = await received
  assert.strictEqual(room, 'css')
  assert.deepStrictEqual(
    users.map((u) => u.username),
    ['alice']
  )
})

test('profanity is rejected without being broadcast', async (t) => {
  const alice = await connect()
  t.after(() => alice.close())

  await emit(alice, 'join', { username: 'alice', room: 'html' })

  assert.match(await emitError(alice, 'sendMessage', 'damn'), /Profanity/)
})

test('a duplicate username in the same room is rejected', async (t) => {
  const alice = await connect()
  const bob = await connect()
  t.after(() => [alice, bob].forEach((s) => s.close()))

  await emit(alice, 'join', { username: 'alice', room: 'js' })
  assert.match(await emitError(bob, 'join', { username: 'alice', room: 'js' }), /in use/)
})

test('missing username or room is rejected', async (t) => {
  const socket = await connect()
  t.after(() => socket.close())

  assert.match(await emitError(socket, 'join', { username: '', room: '' }), /required/)
})

test('sending before joining is rejected, not a crash', async (t) => {
  const socket = await connect()
  t.after(() => socket.close())

  assert.match(await emitError(socket, 'sendMessage', 'hi'), /not in a room/)
})

test('empty and oversized messages are rejected', async (t) => {
  const alice = await connect()
  t.after(() => alice.close())

  await emit(alice, 'join', { username: 'alice', room: 'go' })

  assert.match(await emitError(alice, 'sendMessage', '   '), /cannot be empty/)
  assert.match(await emitError(alice, 'sendMessage', 'x'.repeat(1001)), /fewer/)
})

test('/health returns 200', async () => {
  const res = await fetch(`${URL}/health`)
  assert.strictEqual(res.status, 200)
})

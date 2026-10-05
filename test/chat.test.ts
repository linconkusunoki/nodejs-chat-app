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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Replay arrives as a burst, so a `once` listener is the wrong shape: two of
// them would both fire on the first message. Buffer, then wait for a count.
const collectMessages = (socket: Socket) => {
  const messages: ChatMessage[] = []
  socket.on('message', (message: ChatMessage) => void messages.push(message))
  return messages
}

const waitForMessages = async (messages: ChatMessage[], count: number) => {
  for (let attempt = 0; attempt < 200 && messages.length < count; attempt++) await sleep(25)
  assert.ok(messages.length >= count, `expected ${count} messages, got ${messages.length}`)
}

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

test('a late joiner receives the room history', async (t) => {
  const alice = await connect()
  const bob = await connect()
  t.after(() => [alice, bob].forEach((s) => s.close()))

  await emit(alice, 'join', { username: 'alice', room: 'history-room' })
  await emit(alice, 'sendMessage', 'first')
  await emit(alice, 'sendMessage', 'second')

  const replayed = collectMessages(bob)
  await emit(bob, 'join', { username: 'bob', room: 'history-room' })
  await waitForMessages(replayed, 2)

  assert.deepStrictEqual(
    replayed.slice(0, 2).map((message) => message.text),
    ['first', 'second']
  )
})

test('history is capped and drops the oldest messages', async (t) => {
  const alice = await connect()
  const bob = await connect()
  t.after(() => [alice, bob].forEach((s) => s.close()))

  await emit(alice, 'join', { username: 'alice', room: 'cap-room' })
  for (let i = 0; i < 105; i++) await emit(alice, 'sendMessage', `m${i}`)

  const replayed = collectMessages(bob)
  await emit(bob, 'join', { username: 'bob', room: 'cap-room' })
  // 100 replayed messages plus the "Welcome" system line the join handler adds.
  await waitForMessages(replayed, 101)
  await sleep(100)

  const history = replayed.slice(0, 100)
  assert.strictEqual(history[0]?.text, 'm5')
  assert.strictEqual(history[99]?.text, 'm104')
  assert.strictEqual(replayed[100]?.text, 'Welcome')
})

test('every message carries a unique id', async (t) => {
  const alice = await connect()
  t.after(() => alice.close())

  await emit(alice, 'join', { username: 'alice', room: 'id-room' })

  const first = nextEvent<ChatMessage>(alice, 'message')
  await emit(alice, 'sendMessage', 'one')
  const second = nextEvent<ChatMessage>(alice, 'message')
  await emit(alice, 'sendMessage', 'two')

  assert.ok((await first).id)
  assert.notStrictEqual((await first).id, (await second).id)
})

test('/health returns 200', async () => {
  const res = await fetch(`${URL}/health`)
  assert.strictEqual(res.status, 200)
})

const test = require('node:test')
const assert = require('node:assert')
const { spawn } = require('node:child_process')
const path = require('node:path')
const ioClient = require('socket.io-client')

const PORT = 4123
const URL = `http://localhost:${PORT}`

let server

const startServer = () =>
  new Promise((resolve, reject) => {
    server = spawn(
      process.execPath,
      [path.join(__dirname, '../src/index.js')],
      {
        env: { ...process.env, PORT: String(PORT) },
        stdio: ['ignore', 'pipe', 'inherit'],
      }
    )
    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Server is running up')) resolve()
    })
    server.on('exit', (code) =>
      reject(new Error(`server exited early: ${code}`))
    )
    setTimeout(() => reject(new Error('server did not start in 10s')), 10000)
  })

const connect = () =>
  new Promise((resolve, reject) => {
    const socket = ioClient(URL, { forceNew: true, reconnection: false })
    socket.on('connect', () => resolve(socket))
    socket.on('connect_error', reject)
  })

const emit = (socket, event, payload) =>
  new Promise((resolve, reject) => {
    socket.emit(event, payload, (response) => resolve(response))
    setTimeout(() => reject(new Error(`no ack for '${event}'`)), 5000)
  })

const nextEvent = (socket, event) =>
  new Promise((resolve, reject) => {
    socket.once(event, resolve)
    setTimeout(() => reject(new Error(`no '${event}' received`)), 5000)
  })

test.before(startServer)

test.after(() => server?.kill())

test('a message reaches everyone in the room', async (t) => {
  const alice = await connect()
  const bob = await connect()
  t.after(() => [alice, bob].forEach((s) => s.close()))

  await emit(alice, 'join', { username: 'alice', room: 'js' })
  await emit(bob, 'join', { username: 'bob', room: 'js' })

  const received = nextEvent(bob, 'message')
  await emit(alice, 'sendMessage', 'hello')

  assert.strictEqual((await received).text, 'hello')
})

test('roomData lists every member of the room', async (t) => {
  const alice = await connect()
  t.after(() => alice.close())

  const received = nextEvent(alice, 'roomData')
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

  const error = await emit(alice, 'sendMessage', 'damn')
  assert.match(error, /Profanity/)
})

test('a duplicate username in the same room is rejected', async (t) => {
  const alice = await connect()
  const bob = await connect()
  t.after(() => [alice, bob].forEach((s) => s.close()))

  await emit(alice, 'join', { username: 'alice', room: 'js' })
  const error = await emit(bob, 'join', { username: 'alice', room: 'js' })

  assert.match(error, /in use/)
})

test('missing username or room is rejected', async (t) => {
  const socket = await connect()
  t.after(() => socket.close())

  const error = await emit(socket, 'join', { username: '', room: '' })
  assert.match(error, /required/)
})

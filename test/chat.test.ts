import { test, before, after } from 'node:test'
import assert from 'node:assert'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { io as ioClient, type Socket } from 'socket.io-client'
import type { ChatMessage, RoomData } from '../src/types.ts'
import { MAX_MESSAGE_LENGTH, REACTION_EMOJI } from '../src/types.ts'

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

// A plain `once('message')` races the "x has joined" system line, which can
// land after the listener is attached and would otherwise be mistaken for the
// message under test. Match on the text instead.
const nextMessage = (socket: Socket, text: string) =>
  new Promise<ChatMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error(`no message '${text}' received`))
    }, 5000)

    const onMessage = (message: ChatMessage) => {
      if (message.text !== text) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(message)
    }

    socket.on('message', onMessage)
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

// Assert an event never arrives. Racing a short window is clearer than waiting
// out nextEvent's 5s timeout, and keeps the suite fast.
const expectNoEvent = async (socket: Socket, event: string, ms = 300) => {
  const arrived = new Promise((resolve) => socket.once(event, resolve))
  const silent = await Promise.race([arrived.then(() => false), sleep(ms).then(() => true)])
  assert.ok(silent, `expected no '${event}' event`)
}

before(startServer)
after(() => server?.kill())

test('a message reaches everyone in the room', async (t) => {
  const alice = await connect()
  const bob = await connect()
  t.after(() => [alice, bob].forEach((s) => s.close()))

  await emit(alice, 'join', { username: 'alice', room: 'js' })
  await emit(bob, 'join', { username: 'bob', room: 'js' })

  const received = nextMessage(bob, 'hello')
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

  const first = nextMessage(alice, 'one')
  await emit(alice, 'sendMessage', 'one')
  const second = nextMessage(alice, 'two')
  await emit(alice, 'sendMessage', 'two')

  assert.ok((await first).id)
  assert.notStrictEqual((await first).id, (await second).id)
})

test('userTyping reaches the room but not the sender', async (t) => {
  const alice = await connect()
  const bob = await connect()
  t.after(() => [alice, bob].forEach((s) => s.close()))

  await emit(alice, 'join', { username: 'alice', room: 'typing-room' })
  await emit(bob, 'join', { username: 'bob', room: 'typing-room' })

  const heardByAlice = nextEvent<{ username: string }>(alice, 'userTyping')
  bob.emit('userTyping')

  assert.strictEqual((await heardByAlice).username, 'bob')
  // socket.to() excludes the sender; the typist already knows they are typing.
  await expectNoEvent(bob, 'userTyping')
})

test('userTyping from a socket that never joined is ignored', async (t) => {
  const alice = await connect()
  const orphan = await connect()
  t.after(() => [alice, orphan].forEach((s) => s.close()))

  await emit(alice, 'join', { username: 'alice', room: 'typing-guard' })
  orphan.emit('userTyping')

  // No room for the orphan, so there is nothing to broadcast into.
  await expectNoEvent(alice, 'userTyping')
})

test('roomData carries the message limit for the composer', async (t) => {
  const alice = await connect()
  t.after(() => alice.close())

  const received = nextEvent<RoomData>(alice, 'roomData')
  await emit(alice, 'join', { username: 'alice', room: 'limit-room' })

  // The client sets maxlength and its counter from this, so a mismatch here
  // would let the composer accept text the server then rejects.
  assert.strictEqual((await received).maxMessageLength, MAX_MESSAGE_LENGTH)
})

test('a reaction can be added and taken back by the same user', async (t) => {
  const alice = await connect()
  const bob = await connect()
  t.after(() => [alice, bob].forEach((s) => s.close()))

  await emit(alice, 'join', { username: 'alice', room: 'react-room' })
  await emit(bob, 'join', { username: 'bob', room: 'react-room' })

  const sent = nextMessage(alice, 'react to me')
  await emit(alice, 'sendMessage', 'react to me')
  const { id } = await sent

  const added = nextEvent<ChatMessage>(bob, 'messageUpdated')
  await emit(bob, 'toggleReaction', { id, emoji: '👍' })
  assert.deepStrictEqual((await added).reactions, [{ emoji: '👍', usernames: ['bob'] }])

  // Reacting again is a toggle, and an emptied emoji drops off the row.
  const removed = nextEvent<ChatMessage>(bob, 'messageUpdated')
  await emit(bob, 'toggleReaction', { id, emoji: '👍' })
  assert.deepStrictEqual((await removed).reactions, [])
})

test('reactions from two users share one count', async (t) => {
  const alice = await connect()
  const bob = await connect()
  t.after(() => [alice, bob].forEach((s) => s.close()))

  await emit(alice, 'join', { username: 'alice', room: 'react-two' })
  await emit(bob, 'join', { username: 'bob', room: 'react-two' })

  const sent = nextMessage(bob, 'hi all')
  await emit(alice, 'sendMessage', 'hi all')
  const { id } = await sent

  await emit(alice, 'toggleReaction', { id, emoji: '🎉' })
  const both = nextEvent<ChatMessage>(alice, 'messageUpdated')
  await emit(bob, 'toggleReaction', { id, emoji: '🎉' })

  assert.deepStrictEqual((await both).reactions, [{ emoji: '🎉', usernames: ['alice', 'bob'] }])
})

test('reactions survive in the replayed history', async (t) => {
  const alice = await connect()
  t.after(() => alice.close())

  await emit(alice, 'join', { username: 'alice', room: 'react-history' })
  const sent = nextMessage(alice, 'remember this')
  await emit(alice, 'sendMessage', 'remember this')
  await emit(alice, 'toggleReaction', { id: (await sent).id, emoji: '❤️' })

  const bob = await connect()
  t.after(() => bob.close())
  const replayed = collectMessages(bob)
  await emit(bob, 'join', { username: 'bob', room: 'react-history' })
  await waitForMessages(replayed, 1)

  assert.deepStrictEqual(replayed[0]?.reactions, [{ emoji: '❤️', usernames: ['alice'] }])
})

test('an emoji outside the allowlist is rejected, not stored', async (t) => {
  const alice = await connect()
  t.after(() => alice.close())

  await emit(alice, 'join', { username: 'alice', room: 'react-guard' })
  const sent = nextMessage(alice, 'no arbitrary strings please')
  await emit(alice, 'sendMessage', 'no arbitrary strings please')
  const { id } = await sent

  // The client can send any string here, so it is checked server-side.
  assert.match(await emitError(alice, 'toggleReaction', { id, emoji: '<img src=x>' }), /Unknown/)
  assert.match(await emitError(alice, 'toggleReaction', { id, emoji: '💩' }), /Unknown/)
  assert.match(await emitError(alice, 'toggleReaction', { id, emoji: 42 }), /Unknown/)

  const updated = nextEvent<ChatMessage>(alice, 'messageUpdated')
  await emit(alice, 'toggleReaction', { id, emoji: '👍' })
  assert.deepStrictEqual((await updated).reactions, [{ emoji: '👍', usernames: ['alice'] }])
})

test('reacting to a message that does not exist is rejected', async (t) => {
  const alice = await connect()
  t.after(() => alice.close())

  await emit(alice, 'join', { username: 'alice', room: 'react-missing' })

  assert.match(
    await emitError(alice, 'toggleReaction', { id: 'not-a-real-id', emoji: '👍' }),
    /no longer available/
  )
})

test('reactions cannot be applied from another room', async (t) => {
  const alice = await connect()
  const mallory = await connect()
  t.after(() => [alice, mallory].forEach((s) => s.close()))

  await emit(alice, 'join', { username: 'alice', room: 'room-a' })
  await emit(mallory, 'join', { username: 'mallory', room: 'room-b' })

  const sent = nextMessage(alice, 'private to room a')
  await emit(alice, 'sendMessage', 'private to room a')
  const { id } = await sent

  // findMessage is scoped by the sender's own room, so the id is not reachable.
  assert.match(
    await emitError(mallory, 'toggleReaction', { id, emoji: '👍' }),
    /no longer available/
  )
})

test('roomData lists the reaction picker options', async (t) => {
  const alice = await connect()
  t.after(() => alice.close())

  const received = nextEvent<RoomData>(alice, 'roomData')
  await emit(alice, 'join', { username: 'alice', room: 'picker-room' })

  assert.deepStrictEqual((await received).reactions, [...REACTION_EMOJI])
})

test('an author can edit their own message', async (t) => {
  const alice = await connect()
  const bob = await connect()
  t.after(() => [alice, bob].forEach((s) => s.close()))

  await emit(alice, 'join', { username: 'alice', room: 'edit-room' })
  await emit(bob, 'join', { username: 'bob', room: 'edit-room' })

  const sent = nextMessage(alice, 'typo heer')
  await emit(alice, 'sendMessage', 'typo heer')
  const { id } = await sent

  const updated = nextEvent<ChatMessage>(bob, 'messageUpdated')
  await emit(alice, 'editMessage', { id, text: 'typo here' })

  const message = await updated
  assert.strictEqual(message.text, 'typo here')
  assert.strictEqual(message.id, id)
  assert.ok(message.editedAt, 'editedAt is set')
})

test('an edited message survives replay with its new text', async (t) => {
  const alice = await connect()
  t.after(() => alice.close())

  await emit(alice, 'join', { username: 'alice', room: 'edit-history' })
  const sent = nextMessage(alice, 'before')
  await emit(alice, 'sendMessage', 'before')
  await emit(alice, 'editMessage', { id: (await sent).id, text: 'after' })

  const bob = await connect()
  t.after(() => bob.close())
  const replayed = collectMessages(bob)
  await emit(bob, 'join', { username: 'bob', room: 'edit-history' })
  await waitForMessages(replayed, 1)

  assert.strictEqual(replayed[0]?.text, 'after')
  assert.ok(replayed[0]?.editedAt)
})

test('an edit is held to the same limits as a new message', async (t) => {
  const alice = await connect()
  t.after(() => alice.close())

  await emit(alice, 'join', { username: 'alice', room: 'edit-limits' })
  const sent = nextMessage(alice, 'original')
  await emit(alice, 'sendMessage', 'original')
  const { id } = await sent

  assert.match(await emitError(alice, 'editMessage', { id, text: '  ' }), /cannot be empty/)
  assert.match(await emitError(alice, 'editMessage', { id, text: 'x'.repeat(1001) }), /fewer/)
  assert.match(await emitError(alice, 'editMessage', { id, text: 'damn' }), /Profanity/)

  // The rejected edits left the original alone.
  const replayed = collectMessages(alice)
  await sleep(200)
  assert.ok(replayed.every((message) => message.text !== 'damn'))
})

test("editing someone else's message is rejected", async (t) => {
  const alice = await connect()
  const bob = await connect()
  t.after(() => [alice, bob].forEach((s) => s.close()))

  await emit(alice, 'join', { username: 'alice', room: 'edit-guard' })
  await emit(bob, 'join', { username: 'bob', room: 'edit-guard' })

  const sent = nextMessage(alice, 'alice wrote this')
  await emit(alice, 'sendMessage', 'alice wrote this')
  const { id } = await sent

  assert.match(await emitError(bob, 'editMessage', { id, text: 'bob was here' }), /only edit/)

  const replayed = collectMessages(alice)
  await sleep(200)
  assert.strictEqual(replayed.filter((m) => m.text === 'bob was here').length, 0)
})

test('a message in another room cannot be edited', async (t) => {
  const alice = await connect()
  const mallory = await connect()
  t.after(() => [alice, mallory].forEach((s) => s.close()))

  await emit(alice, 'join', { username: 'alice', room: 'room-a' })
  await emit(mallory, 'join', { username: 'mallory', room: 'room-b' })

  const sent = nextMessage(alice, 'room a only')
  await emit(alice, 'sendMessage', 'room a only')
  const { id } = await sent

  assert.match(await emitError(mallory, 'editMessage', { id, text: 'hijacked' }), /only edit/)
})

test('editing before joining is rejected', async (t) => {
  const socket = await connect()
  t.after(() => socket.close())

  assert.match(await emitError(socket, 'editMessage', { id: 'x', text: 'y' }), /not in a room/)
})

test('an author can delete their own message for everyone', async (t) => {
  const alice = await connect()
  const bob = await connect()
  t.after(() => [alice, bob].forEach((s) => s.close()))

  await emit(alice, 'join', { username: 'alice', room: 'delete-room' })
  await emit(bob, 'join', { username: 'bob', room: 'delete-room' })

  const sent = nextMessage(bob, 'delete me')
  await emit(alice, 'sendMessage', 'delete me')
  const { id } = await sent

  const deleted = nextEvent<{ id: string }>(bob, 'messageDeleted')
  await emit(alice, 'deleteMessage', { id })

  assert.strictEqual((await deleted).id, id)
})

test("deleting someone else's message is rejected", async (t) => {
  const alice = await connect()
  const bob = await connect()
  t.after(() => [alice, bob].forEach((s) => s.close()))

  await emit(alice, 'join', { username: 'alice', room: 'delete-guard' })
  await emit(bob, 'join', { username: 'bob', room: 'delete-guard' })

  const sent = nextMessage(alice, 'alice wrote this')
  await emit(alice, 'sendMessage', 'alice wrote this')
  const { id } = await sent

  assert.match(await emitError(bob, 'deleteMessage', { id }), /only delete/)
  await expectNoEvent(alice, 'messageDeleted')
})

test('a deleted message is gone from the replayed history', async (t) => {
  const alice = await connect()
  t.after(() => alice.close())

  await emit(alice, 'join', { username: 'alice', room: 'delete-history' })
  const sent = nextMessage(alice, 'temporary')
  await emit(alice, 'sendMessage', 'temporary')
  const { id } = await sent
  await emit(alice, 'deleteMessage', { id })

  const bob = await connect()
  t.after(() => bob.close())
  const replayed = collectMessages(bob)
  await emit(bob, 'join', { username: 'bob', room: 'delete-history' })
  await waitForMessages(replayed, 1)
  await sleep(150)

  assert.ok(replayed.every((message) => message.text !== 'temporary'))
})

test('deleting before joining is rejected', async (t) => {
  const socket = await connect()
  t.after(() => socket.close())

  assert.match(await emitError(socket, 'deleteMessage', { id: 'x' }), /not in a room/)
})

test('a brief drop recovers the session, presence and missed messages', async (t) => {
  // Reconnection is on here, which is the point: the client should come back
  // on its own without reloading the page.
  const alice = await ioClient(URL, { forceNew: true, reconnection: true, timeout: 5000 })
  t.after(() => alice.close())
  await new Promise<void>((resolve, reject) => {
    alice.on('connect', () => resolve())
    alice.on('connect_error', reject)
  })

  const bob = await connect()
  t.after(() => bob.close())

  await new Promise<string | undefined>((resolve) =>
    alice.emit('join', { username: 'alice', room: 'recover' }, resolve)
  )
  await emit(bob, 'join', { username: 'bob', room: 'recover' })

  const firstId = alice.id
  const received = collectMessages(alice)

  // Drop the transport without closing the socket, so the client reconnects
  // and offers its recovery token.
  alice.io.engine.close()

  // Bob talks while alice is away; the message has to be waiting on return.
  await emit(bob, 'sendMessage', 'sent while you were out')

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('did not reconnect')), 10000)
    alice.on('connect', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  await sleep(300)

  assert.strictEqual(alice.recovered, true, 'session was recovered')
  assert.strictEqual(alice.id, firstId, 'socket id survived the drop')

  // The message from the outage was replayed, not lost.
  assert.ok(
    received.some((message) => message.text === 'sent while you were out'),
    `missed message was not recovered, got: ${received.map((m) => m.text).join(', ')}`
  )

  // Presence came back too: alice is still in the room and can still post.
  assert.strictEqual(await emit(alice, 'sendMessage', 'back again'), undefined)
})

test('a reconnect without recovery rejoins instead of sitting in no room', async (t) => {
  const alice = await ioClient(URL, { forceNew: true, reconnection: true, timeout: 5000 })
  t.after(() => alice.close())
  await new Promise<void>((resolve, reject) => {
    alice.on('connect', () => resolve())
    alice.on('connect_error', reject)
  })

  await new Promise<string | undefined>((resolve) =>
    alice.emit('join', { username: 'alice', room: 'rejoin' }, resolve)
  )

  const firstId = alice.id
  alice.io.engine.close()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('did not reconnect')), 10000)
    alice.on('connect', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  await sleep(300)

  if (alice.recovered) {
    // Recovery is expected in practice, so this path needs no rejoin.
    assert.strictEqual(alice.id, firstId)
    return
  }

  // A brand new session has no room, so the client has to join again. Emulate
  // what chat.js does on an unrecovered connect.
  assert.notStrictEqual(alice.id, firstId)
  const joined = await new Promise<string | undefined>((resolve) =>
    alice.emit('join', { username: 'alice', room: 'rejoin' }, resolve)
  )
  assert.strictEqual(joined, undefined)
  assert.strictEqual(await emit(alice, 'sendMessage', 'still works'), undefined)
})

test('/health returns 200', async () => {
  const res = await fetch(`${URL}/health`)
  assert.strictEqual(res.status, 200)
})

const socket = io()

// Elements
const $chat = document.querySelector('.chat')
const $scrim = document.querySelector('#scrim')
const $menuToggle = document.querySelector('#menu-toggle')
const $roomTitle = document.querySelector('#room-title')
const $messageForm = document.querySelector('#message-form')
const $messageFormInput = $messageForm.querySelector('input')
const $messageFormButton = $messageForm.querySelector('button')
const $counter = document.querySelector('#counter')
const $messages = document.querySelector('#messages')
const $thread = document.querySelector('#thread')
const $typing = document.querySelector('#typing')
const $sidebar = document.querySelector('#sidebar')
const $status = document.querySelector('#status')
const baseTitle = document.title

// Render's free tier spins the instance down after 15 minutes idle, so the
// socket can drop mid-conversation. Show it rather than looking frozen.
// Unread tracking. document.hidden is the signal: it covers a backgrounded tab
// and a minimised window without needing a focus-tracking hack, and the
// server has no idea any of this happened.
let unread = 0

const resetUnread = () => {
  unread = 0
  document.title = baseTitle
}

document.addEventListener('visibilitychange', () => !document.hidden && resetUnread())
window.addEventListener('focus', resetUnread)

// Browsers only grant Notification from a user gesture, so ask on the first one
// rather than on page load where the request is silently ignored.
if ('Notification' in window && Notification.permission === 'default') {
  document.addEventListener('click', () => void Notification.requestPermission(), { once: true })
}

const notifyUnread = (message) => {
  unread += 1
  document.title = `(${unread}) ${baseTitle}`

  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(message.username, { body: message.text })
  }
}

const setStatus = (text) => {
  $status.textContent = text || ''
  $status.hidden = !text
}

socket.on('disconnect', () => setStatus('Connection lost. Reconnecting...'))
socket.on('connect', () => setStatus(''))
socket.on('connect_error', () => setStatus('Cannot reach the server yet...'))

// Mobile drawer
const setDrawer = (open) => {
  $chat.classList.toggle('is-open', open)
  $menuToggle.setAttribute('aria-expanded', String(open))
}

$menuToggle.addEventListener('click', () => setDrawer(!$chat.classList.contains('is-open')))
$scrim.addEventListener('click', () => setDrawer(false))
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setDrawer(false)
})

// Templates
const messageTemplate = document.querySelector('#message-template').innerHTML
const systemTemplate = document.querySelector('#system-template').innerHTML
const dividerTemplate = document.querySelector('#divider-template').innerHTML
const sidebarTemplate = document.querySelector('#sidebar-template').innerHTML

// Options
const options = Qs.parse(location.search, {
  ignoreQueryPrefix: true,
})

// The server normalizes usernames to trim().toLowerCase(); match it exactly or
// your own messages render on the other side of the thread.
const username = String(options.username ?? '')
  .trim()
  .toLowerCase()

const ADMIN = 'admin'

// Usernames are user input and end up inside an HTML attribute below, so they
// need the same escaping Mustache does for the templated parts of the page.
const escapeAttr = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  )

const initials = (name) => name.slice(0, 2).toUpperCase()

const throttle = (fn, ms) => {
  let last = 0
  return () => {
    const now = Date.now()
    if (now - last < ms) return
    last = now
    fn()
  }
}

const hue = (name) => {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)) % 360
  return hash
}

const autoScroll = () => {
  // new message element
  const $newMessage = $thread.lastElementChild
  if (!$newMessage) return

  // height of the new message
  const newMessageStyles = getComputedStyle($newMessage)
  const newMessageMargin = parseInt(newMessageStyles.marginBottom)
  const newMessageHeight = $newMessage.offsetHeight + newMessageMargin

  // visible height
  const visibleHeight = $messages.offsetHeight

  // height of messages container
  const containerHeight = $messages.scrollHeight

  // how far have I scrolled?
  const scrollOffset = $messages.scrollTop + visibleHeight

  if (containerHeight - newMessageHeight <= scrollOffset) {
    $messages.scrollTop = $messages.scrollHeight
  }
}

let pickerEmoji = []

const findMessageEl = (id) => $thread.querySelector(`.msg[data-id="${id}"]`)

// Chips are built in JS rather than in the Mustache template because they
// change without the message itself changing, and the emoji list only arrives
// with roomData — after the first messages have already rendered.
const renderReactions = (message) => {
  const row = findMessageEl(message.id)?.querySelector('[data-reactions]')
  if (!row) return

  const chips = (message.reactions ?? []).map((reaction) => {
    const mine = reaction.usernames.includes(username)
    const who = escapeAttr(reaction.usernames.join(', '))
    return (
      `<button class="chip${mine ? ' chip--mine' : ''}" type="button"` +
      ` data-reaction="${escapeAttr(reaction.emoji)}" title="${who}"` +
      ` aria-pressed="${mine}">${reaction.emoji}` +
      `<span class="chip__count">${reaction.usernames.length}</span></button>`
    )
  })

  row.innerHTML =
    chips.join('') + '<button class="chip chip--add" type="button" data-add-reaction>+</button>'
}

const togglePicker = (article) => {
  const picker = article?.querySelector('[data-picker]')
  if (!picker) return

  picker.innerHTML = pickerEmoji
    .map(
      (emoji) => `<button class="msg__emoji" type="button" data-emoji="${emoji}">${emoji}</button>`
    )
    .join('')
  picker.hidden = !picker.hidden
}

$thread.addEventListener('click', (event) => {
  const chosen = event.target.closest('[data-reaction], [data-emoji]')
  if (chosen) {
    const article = chosen.closest('.msg')
    const picker = article?.querySelector('[data-picker]')
    if (picker) picker.hidden = true

    socket.emit('toggleReaction', {
      id: article?.dataset.id,
      emoji: chosen.dataset.reaction ?? chosen.dataset.emoji,
    })
    return
  }

  if (event.target.closest('[data-add-reaction]')) {
    togglePicker(event.target.closest('.msg'))
  }
})

socket.on('messageUpdated', renderReactions)

let previousAuthor = null
let previousTime = null

// A run from the same author breaks if the conversation paused, otherwise a
// 40-minute gap still renders as one continuous block with no timestamps.
const GROUP_GAP = 5 * 60 * 1000

const dayKey = (ts) => {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const dayLabel = (ts) => {
  const days = Math.round((dayKey(Date.now()) - dayKey(ts)) / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

socket.on('message', (message) => {
  const author = message.username.toLowerCase()
  const isSystem = author === ADMIN
  const newDay = previousTime === null || dayKey(message.createdAt) !== dayKey(previousTime)
  const stale = previousTime !== null && message.createdAt - previousTime > GROUP_GAP

  if (newDay) {
    $thread.insertAdjacentHTML(
      'beforeend',
      Mustache.render(dividerTemplate, { label: dayLabel(message.createdAt) })
    )
  }

  const html = isSystem
    ? Mustache.render(systemTemplate, { message: message.text })
    : Mustache.render(messageTemplate, {
        username: message.username,
        message: message.text,
        id: message.id,
        initials: initials(author),
        hue: hue(author),
        own: author === username,
        grouped: author === previousAuthor && !stale && !newDay,
        createdAt: new Date(message.createdAt).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        }),
      })

  $thread.insertAdjacentHTML('beforeend', html)

  if (!isSystem) renderReactions(message)

  // Only other people's messages while the tab is out of sight count as
  // unread; your own and the system lines would be noise in the count.
  if (document.hidden && !isSystem && author !== username) notifyUnread(message)

  // System lines break the run so the next message gets a fresh header.
  previousAuthor = isSystem ? null : author
  previousTime = message.createdAt
  autoScroll()
})

socket.on('roomData', ({ room: roomName, users, maxMessageLength, reactions }) => {
  const html = Mustache.render(sidebarTemplate, {
    room: roomName,
    initial: initials(roomName),
    count: users.length,
    users: users.map((user) => ({
      username: user.username,
      initials: initials(user.username),
      hue: hue(user.username),
    })),
  })
  $sidebar.innerHTML = html
  $roomTitle.textContent = roomName

  // The native maxlength does the enforcing; the counter is just the warning
  // shot. Both read the same server value so they cannot disagree.
  $messageFormInput.maxLength = maxMessageLength
  $counter.hidden = false

  // Fills the "+" picker for messages that rendered before roomData arrived.
  pickerEmoji = reactions
})

// Only worth showing once the limit is close enough to matter.
const COUNTER_THRESHOLD = 100

$messageFormInput.addEventListener('input', () => {
  const remaining = $messageFormInput.maxLength - $messageFormInput.value.length
  $counter.textContent = String(remaining)
  $counter.hidden = remaining > COUNTER_THRESHOLD
})

// Typing indicator. The client throttles its own emits and the server only
// relays; expiry is a client timer, so a typing user who closes the tab stops
// showing up without the server needing to track anyone's keystrokes.
const TYPING_TTL = 3000
const typing = new Map()

const renderTyping = () => {
  const now = Date.now()
  for (const [name, last] of typing) {
    if (now - last >= TYPING_TTL) typing.delete(name)
  }

  const names = [...typing.keys()].sort()
  if (!names.length) {
    $typing.textContent = ''
    $typing.hidden = true
    return
  }

  const who =
    names.length === 1
      ? `${names[0]} is typing`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are typing`
        : `${names[0]} and ${names.length - 1} others are typing`

  $typing.textContent = `${who}…`
  $typing.hidden = false

  setTimeout(renderTyping, TYPING_TTL)
}

socket.on('userTyping', ({ username: who }) => {
  typing.set(who, Date.now())
  renderTyping()
})

// Sending or dropping means they stopped typing; the TTL alone would leave a
// stale "is typing" on screen for three seconds.
const clearTyping = () => {
  if (!typing.size) return
  typing.clear()
  renderTyping()
}

socket.on('message', clearTyping)
socket.on('disconnect', clearTyping)

$messageFormInput.addEventListener(
  'input',
  throttle(() => socket.emit('userTyping'), 1500)
)

// Copy reads the rendered text straight out of the DOM, so there is no second
// id-to-text map on the client to keep in step with the thread.
$thread.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy]')
  if (!button) return

  const text = button.closest('.msg')?.querySelector('.msg__text')?.textContent
  if (!text) return

  try {
    await navigator.clipboard.writeText(text)
  } catch {
    return
  }

  button.classList.add('is-copied')
  button.setAttribute('aria-label', 'Copied')

  setTimeout(() => {
    button.classList.remove('is-copied')
    button.setAttribute('aria-label', 'Copy message')
  }, 1200)
})

$messageForm.addEventListener('submit', (e) => {
  e.preventDefault()

  $messageFormButton.setAttribute('disabled', 'disabled')

  const message = e.target.elements.message.value
  socket.emit('sendMessage', message, (error) => {
    $messageFormButton.removeAttribute('disabled')
    $messageFormInput.value = ''
    $messageFormInput.focus()

    if (error) {
      return console.log(error)
    }

    console.log('Message delivered!')
  })
})

socket.emit('join', { username, room: options.room }, (error) => {
  if (error) {
    alert(error)
    location.href = '/'
  }
})

const socket = io()

// Elements
const $chat = document.querySelector('.chat')
const $scrim = document.querySelector('#scrim')
const $menuToggle = document.querySelector('#menu-toggle')
const $roomTitle = document.querySelector('#room-title')
const $messageForm = document.querySelector('#message-form')
const $messageFormInput = $messageForm.querySelector('input')
const $messageFormButton = $messageForm.querySelector('button')
const $messages = document.querySelector('#messages')
const $thread = document.querySelector('#thread')
const $sidebar = document.querySelector('#sidebar')
const $status = document.querySelector('#status')

// Render's free tier spins the instance down after 15 minutes idle, so the
// socket can drop mid-conversation. Show it rather than looking frozen.
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

const initials = (name) => name.slice(0, 2).toUpperCase()

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

let previousAuthor = null

socket.on('message', (message) => {
  const author = message.username.toLowerCase()
  const isSystem = author === ADMIN

  const html = isSystem
    ? Mustache.render(systemTemplate, { message: message.text })
    : Mustache.render(messageTemplate, {
        username: message.username,
        message: message.text,
        initials: initials(author),
        hue: hue(author),
        own: author === username,
        grouped: author === previousAuthor,
        createdAt: new Date(message.createdAt).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        }),
      })

  $thread.insertAdjacentHTML('beforeend', html)

  // System lines break the run so the next message gets a fresh header.
  previousAuthor = isSystem ? null : author
  autoScroll()
})

socket.on('roomData', ({ room: roomName, users }) => {
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

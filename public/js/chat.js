const socket = io()

// Elements
const $messageForm = document.querySelector('#message-form')
const $messageFormInput = $messageForm.querySelector('input')
const $messageFormButton = $messageForm.querySelector('button')
const $messages = document.querySelector('#messages')
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

// Templates
const messageTemplate = document.querySelector('#message-template').innerHTML
const sidebarTemplate = document.querySelector('#sidebar-template').innerHTML

// Options
const { username, room } = Qs.parse(location.search, {
  ignoreQueryPrefix: true,
})

const autoScroll = () => {
  // new message element
  const $newMessage = $messages.lastElementChild

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

socket.on('message', (message) => {
  const html = Mustache.render(messageTemplate, {
    username: message.username,
    message: message.text,
    createdAt: new Date(message.createdAt).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    }),
  })
  $messages.insertAdjacentHTML('beforeend', html)
  autoScroll()
})

socket.on('roomData', ({ room: roomName, users }) => {
  const html = Mustache.render(sidebarTemplate, {
    room: roomName,
    users,
  })
  $sidebar.innerHTML = html
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

socket.emit('join', { username, room }, (error) => {
  if (error) {
    alert(error)
    location.href = '/'
  }
})

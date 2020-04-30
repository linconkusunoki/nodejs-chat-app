const generateMessage = (username, text) => ({
  text,
  username,
  createdAt: new Date().getTime(),
})

const generateLocationMessage = (username, url) => ({
  url,
  username,
  createdAt: new Date().getTime(),
})

module.exports = {
  generateMessage,
  generateLocationMessage,
}

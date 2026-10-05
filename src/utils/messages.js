const generateMessage = (username, text) => ({
  text,
  username,
  createdAt: new Date().getTime(),
})

module.exports = {
  generateMessage,
}

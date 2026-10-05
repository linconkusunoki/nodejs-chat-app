import type { ChatMessage } from '../types.ts'

export const generateMessage = (username: string, text: string): ChatMessage => ({
  text,
  username,
  createdAt: Date.now(),
})

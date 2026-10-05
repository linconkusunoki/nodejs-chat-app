import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public')

export const createApp = () => {
  const app = express()

  app.get('/health', (_req, res) => res.status(200).send('ok'))
  app.use(express.static(publicDir))

  return app
}

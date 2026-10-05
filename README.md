# Chat App

A small real-time chat app: rooms, presence, and live delivery over Socket.IO, with a
vanilla JS frontend and no build step.

Built as a portfolio project — the point is the architecture and the tooling, not scale.

<!-- TODO: add the live demo link here once the Render service is up -->

## What it does

- Join a named room with a display name
- Messages are broadcast live to everyone in the room
- A sidebar shows who is currently in the room, updated on join and leave
- Profanity is filtered server-side
- Message length is capped and empty messages are rejected

## Running it locally

```bash
npm install
npm run dev        # watch mode
npm start          # normal start
```

Then open http://localhost:3000. The port comes from `PORT` if set.

To try it out, open the URL in two windows and use the same room name.

## Scripts

| command             | what it does                                           |
| ------------------- | ------------------------------------------------------ |
| `npm run dev`       | start with reload on change (`tsx watch`)              |
| `npm start`         | start the server                                       |
| `npm test`          | integration tests against a real server + real sockets |
| `npm run lint`      | `oxlint` + `oxfmt --check`                             |
| `npm run format`    | apply `oxfmt`                                          |
| `npm run typecheck` | `tsc --noEmit`                                         |

CI runs all three of lint, typecheck, and test on every push and PR.

## Architecture

```
src/
  index.ts        bootstrap: http + socket.io server, signal handlers, listen
  app.ts          express app: /health endpoint and static files
  socket.ts       all socket event handlers (join, sendMessage, disconnect)
  types.ts        shared payload types and the message length limit
  utils/
    users.ts      in-memory presence store
    messages.ts   message factory
public/           static frontend, served as-is
test/             integration tests
```

The frontend is intentionally plain HTML, CSS, and JS loaded from a CDN with
Mustache templates. There is no bundler and no framework — a chat app is not the place
to find out whether React is a good idea.

### Types

TypeScript runs in `strict` mode across `src/` and `test/`. It earns its keep in one
specific place: every socket handler takes its payload as `unknown` and narrows it before
use, so a malformed client message is a rejected promise rather than a `TypeError`.
The `ChatMessage` and `RoomData` interfaces in `src/types.ts` are shared between the
server and the tests, so a change to a payload shape breaks the build in both places.

### Error handling

Socket handlers validate their input and acknowledge with an error string instead of
throwing. `uncaughtException` and `unhandledRejection` are logged, not fatal: one bad
message should not take the room down. `SIGTERM` and `SIGINT` close the Socket.IO server
and then the HTTP server, which is what Render sends before replacing an instance.

## Testing

`test/chat.test.ts` boots the real server as a subprocess and drives it with real
Socket.IO clients over a real port. No mocks, no in-memory adapter. It covers message
delivery, presence, profanity rejection, join validation, sending before joining,
length limits, and the health endpoint.

## Deployment

Deployed on [Render](https://render.com) as a Node web service:

- build command: `npm ci`
- start command: `npm start`
- health check path: `/health`

No database. State is in memory, which is fine for a single instance and matches what
the app actually does. Message history is not persisted — a refresh gives you an empty
room. That is a deliberate choice, not an oversight; a persistent store would be the
first thing to add if this were a real product.

### One caveat about the free tier

Render's free tier spins the instance down after 15 minutes of inactivity, and it takes
about a minute to wake back up. Visitors see a loading page during that window. The
client shows a "Connection lost. Reconnecting..." banner when the socket drops, so the
app looks asleep rather than broken.

## Things I deliberately left out

- **Authentication.** Anyone can claim any display name. Real auth is the first thing
  this would need.
- **Message history.** In memory only, lost on restart.
- **Rate limiting.** A client can send as fast as it likes.
- **A database.** See above.

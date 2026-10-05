# Chat App

A small real-time chat app: rooms, presence, and live delivery over Socket.IO, with a
vanilla JS frontend and no build step.

Built as a portfolio project — the point is the architecture and the tooling, not scale.

<!-- TODO: add the live demo link here once the Render service is up -->

## What it does

- Join a named room with a display name
- Messages are broadcast live to everyone in the room
- A sidebar shows who is currently in the room, updated on join and leave
- Recent messages replay when you join a room that already has a conversation
- Typing indicator, so you know when someone is mid-sentence
- Unread count in the tab title and a desktop notification while the tab is in
  the background
- Emoji reactions, and a copy button on every message
- Edit and delete your own messages, which update for everyone at once
- Consecutive messages group by author and break on a pause or a new day
- Profanity is filtered server-side
- Message length is capped and empty messages are rejected
- A dropped connection recovers on its own, keeping the room and the messages
  missed while offline

## Running it locally

```bash
npm install
npm run dev        # watch mode
npm start          # normal start
```

Then open http://localhost:3000. The port comes from `PORT` if set.

To try it out, open the URL in two windows and use the same room name.

## Scripts

| command             | what it does                                            |
| ------------------- | ------------------------------------------------------- |
| `npm run dev`       | start with reload on change (`tsx watch`)               |
| `npm start`         | start the server                                        |
| `npm test`          | integration tests against a real server + real sockets  |
| `npm run smoke`     | headless-browser checks for the frontend (needs Chrome) |
| `npm run lint`      | `oxlint` + `oxfmt --check`                              |
| `npm run format`    | apply `oxfmt`                                           |
| `npm run typecheck` | `tsc --noEmit`                                          |

CI runs all three of lint, typecheck, and test on every push and PR. The smoke
test is not in CI, since that would make a browser a hard requirement for the
build; run it locally after touching anything in `public/`.

## Architecture

```
src/
  index.ts        bootstrap: http + socket.io server, signal handlers, listen
  app.ts          express app: /health endpoint and static files
  socket.ts       all socket event handlers (join, sendMessage, reactions, ...)
  types.ts        shared payload types, the message limit, the reaction allowlist
  utils/
    users.ts      in-memory presence store
    messages.ts   message factory + per-room history store
public/           static frontend, served as-is
test/             integration tests
smoke.mjs         headless-browser checks for public/
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

The same narrowing decides what a client is allowed to store. The reaction allowlist
lives in `src/types.ts` and is checked server-side, because the picker payload is just
whatever string the client sent; it is also shipped to the browser in `roomData`, so the
picker can never offer an emoji the server would reject. The message length limit takes
the same route and sets the composer's native `maxlength`.

### Error handling

Socket handlers validate their input and acknowledge with an error string instead of
throwing. `uncaughtException` and `unhandledRejection` are logged, not fatal: one bad
message should not take the room down. `SIGTERM` and `SIGINT` close the Socket.IO server
and then the HTTP server, which is what Render sends before replacing an instance.

## Testing

`test/chat.test.ts` boots the real server as a subprocess and drives it with real
Socket.IO clients over a real port. No mocks, no in-memory adapter. It covers message
delivery, presence, history replay and its cap, profanity rejection, join validation,
sending before joining, length limits, reactions (including the allowlist and
cross-room boundaries), edit and delete authorisation, connection recovery, and the
health endpoint.

`smoke.mjs` covers the other half. It drives two real pages in headless Chrome over the
DevTools protocol — no new dependency, it uses Node's global `WebSocket` — and asserts
what actually got rendered: the typing indicator, the unread count, date dividers, the
character counter, reaction chips, inline editing, deletion, and that a network cut is
recovered from without duplicating the thread. It finds Chrome across platforms, honours
`CHROME_PATH`, and skips rather than failing when no browser is installed.

## Deployment

Deployed on [Render](https://render.com) as a Node web service:

- build command: `npm ci`
- start command: `npm start`
- health check path: `/health`

No database. State is in memory, which is fine for a single instance and matches what
the app actually does. History is capped at the last 100 messages per room and is not
persisted, so it does not survive a restart or a deploy. That is a deliberate choice,
not an oversight; a persistent store would be the first thing to add if this were a real
product.

### One caveat about the free tier

Render's free tier spins the instance down after 15 minutes of inactivity, and it takes
about a minute to wake back up. Visitors see a loading page during that window. The
client shows a "Connection lost. Reconnecting..." banner when the socket drops, so the
app looks asleep rather than broken.

Once the server is back, Socket.IO's connection state recovery restores the socket id,
the room, and the messages that arrived while the client was away, so the conversation
resumes where it left off instead of needing a reload.

## Things I deliberately left out

- **Authentication.** Anyone can claim any display name, and ownership of a message is
  just a name comparison. Real auth is the first thing this would need, and it is what
  would make edit and delete trustworthy rather than best-effort.
- **Rate limiting.** A client can send as fast as it likes.
- **A database.** See above.
- **Persistent history.** The last 100 messages per room live in memory.
- **Read receipts, DMs, file uploads.** None of these are hard, they are just more than
  this needed to be worth building.

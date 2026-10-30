# Smuggler

A Jackbox-style party game. Put it on the TV, and everyone plays from their phone.

## The game

Everyone answers the same writing prompt, like *"Write a 5-star review of a toaster."* Each player also gets a secret **contraband word** (*pelican*, *lasagna*, *kazoo*…) that they have to sneak into their answer.

1. **Smuggle:** write an answer that hides your word so naturally nobody notices it. Plurals and possessives count. You can swap a hard word once per game.
2. **Inspect:** every answer appears on the TV without names. On your phone, tap the word you think was smuggled into each one.
3. **Busted?:** the TV unmasks the answers one at a time. It shows the smuggled word, who wrote it, which words people guessed, and who caught it.

**Scoring:** you get +100 for each word you catch, and +50 for each player your own word slips past. Adding weird decoy words to your answer is encouraged.

The game is 5 rounds for 3–10 players. At the end, the TV awards **🕶️ Master Smuggler** (fooled the most players) and **🐕 Bloodhound** (caught the most words).

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # plays a full game with simulated phones
```

- **TV:** open `http://<your-computer-ip>:3000/host` on the TV's browser, or open it in Chrome on a laptop and **Cast tab** to the TV.
- **Phones:** scan the QR code, or go to `http://<your-computer-ip>:3000/play` and enter the 4-letter room code.
- The first player to join is the **♛ VIP**. They start the game and move it along from their phone. The TV has the same buttons, plus *Skip timer* and *New room*.

Phones and the TV need to be on the same Wi-Fi when running locally. To play over the internet, deploy it to a host that supports long-lived WebSocket servers (Render, Railway, Fly.io, a VPS…). Serverless platforms like Vercel won't keep the game server alive.

If a phone refreshes or drops, the player gets their seat back automatically. A player can also rejoin on another device by typing the same name.

## Layout

```
server.js          Express + Socket.IO server, room registry
src/room.js        Game rules and state machine (lobby → write → hunt → reveal → scores → end)
src/words.js       Prompts and contraband words (edit these to add your own)
public/host.*      TV screen
public/play.*      Phone controller
test/smoke.js      End-to-end test
```

Timers, rounds, and points are set at the top of `src/room.js`.

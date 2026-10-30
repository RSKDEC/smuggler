# Smuggler

A Jackbox-style party game. Put it on the TV, and everyone plays from their phone.

## The game

Everyone answers the same writing prompt, like *"Write a 5-star review of a toaster."* Each player also gets a secret **contraband word** (*pelican*, *lasagna*, *kazoo*…) that they have to sneak into their answer.

0. **Lobby:** each player picks a suitcase character on their phone, with a color and a disguise (mustache, shades, fedora…). The characters walk through the customs gate on the TV.
1. **Smuggle:** write an answer that hides your word so naturally nobody notices it. Plurals and possessives count. You can swap a hard word once per game.
2. **Inspect:** every answer appears on the TV without names. On your phone, tap the word you think was smuggled into each one, and ❤️ your favorite answer.
3. **Busted?:** for each answer, an X-ray scanner sweeps across it and the guessers' characters pin themselves to the words they picked. Then the smuggled word lights up and a **BUSTED** or **CLEARED** stamp slams down.
4. **Scores:** the crowd favorite is shown, then the leaderboard slides into its new order while scores count up.

| Scoring | Points |
| --- | --- |
| Catch someone's word | +100 |
| Each player your word slips past | +50 |
| Perfect decoy: 2+ players tap the same wrong word in your answer | +50 |
| Crowd favorite: most ❤️ that round | +100 |

The game is 5 rounds for 3–10 players. At the end, the TV awards **🕶️ Master Smuggler** (fooled the most players), **🐕 Bloodhound** (caught the most words) and **❤️ Crowd Favorite** (won the most rounds of ❤️ votes).

**Sound:** the TV plays sound effects and a background loop, all synthesized in the browser (no audio files). Click anywhere on the TV page once to turn sound on, and use 🔊/🔇 to mute.

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
public/avatar.js   Suitcase characters (SVG)
public/sound.js    Synthesized sound effects and music
test/smoke.js      End-to-end test
```

Timers, rounds, and points are set at the top of `src/room.js`.

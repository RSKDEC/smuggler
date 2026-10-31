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
| 💰 Most Wanted bounty: catching the current leader's word | +50 extra |

**🔥 Double Contraband finale:** in the last round everyone smuggles two words, guessers tap two words per answer, and all points are doubled.

**💰 Most Wanted:** from round 2, the leader's answer is marked WANTED on the TV, and anyone who catches their word earns a bounty.

The game is 5 rounds for 3–10 players. At the end, the TV awards **🕶️ Master Smuggler** (fooled the most players), **🐕 Bloodhound** (caught the most words) and **❤️ Crowd Favorite** (won the most rounds of ❤️ votes).

**Sound:** the TV plays sound effects and a background loop, all synthesized in the browser (no audio files). Click anywhere on the TV page once to turn sound on, and use 🔊/🔇 to mute.

## Settings and host controls (VIP's phone)

Once the TV is cast, nobody can click on it, so the **♛ VIP** (the first player to join) runs the game from their phone:

- **Lobby settings:** word pack (Classic, Family-friendly, Office party), 3/5/7 rounds, pace (Relaxed, Normal, Quick), and the finale and Most Wanted switches.
- **Host controls** during the game: pause/resume, skip the timer, remove a player.

The TV keeps its own Start, Next, Pause and Skip buttons for when it's run from a laptop.

## Deploy on Render

The repo includes a `render.yaml`. In Render, choose **New → Blueprint** and pick this repository, or create a **Web Service** with build command `npm ci` and start command `npm start`. Open `https://<your-app>.onrender.com/host` on the TV.

Free Render services go to sleep after about 15 minutes without traffic, so the first visit afterwards can take up to a minute to load.

## Cast to a Chromecast

The TV screen can run directly on a Chromecast (including Chromecast with Google TV), started from a phone, with no laptop needed.

One-time setup:

1. In the [Google Cast SDK Developer Console](https://cast.google.com/publish) (one-time $5 fee), choose **Add new application → Custom Receiver**. Set the receiver URL to `https://<your-app>.onrender.com/cast`, then copy the **Application ID** it gives you.
2. In the same console, choose **Add new device** and enter your Chromecast's serial number. Unpublished apps only run on registered devices. Registration can take about 15 minutes, and then you restart the Chromecast.
3. Put the Application ID in `server.js` (the default is `71725E91`, registered for smuggler.onrender.com), or set the `CAST_APP_ID` environment variable in Render to override it.

To play: on an **Android phone using Chrome** (or Chrome on a laptop), on the same Wi-Fi as the Chromecast, open `/play` and tap **📺 Cast a new game to your TV**. The TV shows the room code, and everyone joins as usual; iPhones can join, they just can't start the cast. A player already in a game can tap **📺 Cast** in the top bar to move that game onto the TV.

How it works: `public/cast.js` is the phone side (Cast Web Sender) and `public/cast.html` + `cast-receiver.js` run on the Chromecast (Cast Web Receiver). They exchange the room code over the `urn:x-cast:com.smuggler.game` channel. Opening `/cast` in a normal browser acts like `/host`, which is handy for testing.

## Android TV app (Chromecast with Google TV)

`android-tv/` is a small Android TV app that opens the TV screen (`/tv`) full-screen, with its own tile in the Google TV Apps row. GitHub Actions builds it on every change under `android-tv/` and publishes the APK to the game server at **`/app`** (`/smuggler-tv.apk`).

Install it once on the Chromecast (sideloading, free):

1. **Settings → System → About**, then click **Android TV OS build** 7 times until it says you're a developer.
2. Install **Downloader** (by AFTVnews) from the Play Store.
3. **Settings → Apps → Security & restrictions → Unknown sources**, then turn on **Downloader**.
4. Open Downloader, enter `smuggler.onrender.com/app`, and choose **Install**.
5. Open **Smuggler** from your Apps. Players join on their phones, and the VIP's phone runs the game.

To update, repeat step 4; it installs over the old version. The app is signed with a sideload-only key committed in the repo. Publishing to the Play Store would need a new private key.

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
src/words.js       Word packs: prompts and contraband words (edit these to add your own)
public/host.*      TV screen
public/play.*      Phone controller
public/avatar.js   Suitcase characters (SVG)
public/sound.js    Synthesized sound effects and music
public/cast.js     Chromecast sender (phone's Cast button)
public/cast.html   Chromecast receiver page (+ cast-receiver.js)
public/icon.svg    App icon (source); PNG sizes in public/icons via scripts/make-icons.js
public/tv.html     TV screen for the Android TV app (no buttons, sound on)
android-tv/        Android TV app (WebView wrapper), built by .github/workflows/android-tv.yml
test/smoke.js      End-to-end test
```

Timers, rounds, and points are set at the top of `src/room.js`.

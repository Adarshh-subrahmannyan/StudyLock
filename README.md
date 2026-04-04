# StudyLock

StudyLock is a modern, aggressive web browser extension designed to eliminate procrastination and fiercely protect your study time. Unlike traditional blockers that rely on "blacklists", StudyLock operates using a **Whitelisted-Only Environment** — meaning when a session is active, the entire internet is blocked *except* for the few domains you explicitly allow.

## 🚀 Key Features

*   **Whitelist-First Blocking:** During active sessions, every single website is blocked unless it is explicitly inside your Whitelist.
*   **Granular YouTube Filtering:** Need YouTube for a tutorial? Add `youtube.com` to your whitelist and specify allowed educational channels (e.g., `@PhysicsWallah`). All other entertainment channels will be instantly blocked.
*   **Pomodoro Engine:** Seamlessly cycles between 25-minute study sprints and 5-minute reward breaks where the internet briefly unlocks.
*   **Daily Goals & Streaks:** Start your day by declaring a mission. StudyLock tracks your consecutive study days and visually charts your progress toward the day's target.
*   **Smart Breaks:** If you're studying continuously without pausing, the extension detects burnout and provides dynamic, unskippable breaks.
*   **Tamper Protection (PIN Lock):** Changing settings, adding sites, or forcing a session to close early requires a 4-digit PIN. Stop yourself from quitting early in a moment of weakness!
*   **Night Lockdowns:** Automatically blocks Late-Night surfing and forces you to go to bed if a session crosses your designated cutoff time.
*   **Parental Controls & Telegram Reporting:** 
    *   *Strict Lockdown:* Keeps the internet permanently disabled unless a study timer is running. 
    *   *Telegram Alerts:* Sends real-time messages to a designated Telegram chat when a session begins, and delivers a rigorous summary of exactly which websites were visited when a session ends.

## ⚙️ Installation

### Firefox (Recommended)
1. Download or clone this repository to your local machine.
2. Open Firefox and enter `about:debugging#/runtime/this-firefox` in the URL bar.
3. Click on the **"Load Temporary Add-on..."** button.
4. Select the `manifest.json` file inside the StudyLock folder.
5. StudyLock will appear on your toolbar!

### Chrome / Edge / Brave
1. Go to `chrome://extensions/` 
2. Turn on **Developer mode** in the top right corner.
3. Click **Load unpacked** in the upper left.
4. Select the folder containing StudyLock.

## 📖 Usage Guide

**1. Onboarding & PIN Setup**
When you fire up StudyLock for the first time, you will be prompted to create a 4-Digit PIN. **Do not forget this PIN.** You will need it to edit your allowed websites and access the settings panel.

**2. Configuring the Whitelist**
Click the Settings (gear icon) in the top right of the StudyLock popup menu to access your Dashboard. Under the "Whitelist" section, add the URLs you need for schoolwork (e.g. `wikipedia.org`, `docs.google.com`).

**3. Starting a Session**
Click the extension icon to see your StudyLock timer. Set your desired session duration (or click a quick preset like `25m`) and click **Start Focus Session**. If "Pomodoro" is enabled, the timer will automatically trigger breaks for you.

**4. Expanding Control**
Head back into Settings to connect a Telegram Bot for usage reporting, configure night-time cutoff warnings, or enable Strict Lockdown.

## 🤖 Telegram Notification Setup

StudyLock can automatically send you notifications directly to your phone via Telegram when sessions start, end, or if late-night boundaries are crossed.

**How to get your Bot Token and Chat ID:**
1. Open Telegram and search for the **@BotFather** bot.
2. Send the message `/newbot` and follow the prompts to name your bot and choose a username.
3. BotFather will reply with your **HTTP API Token** (a long string of numbers and letters). Copy this!
4. Now, search for your newly created bot in Telegram and send it a simple message like "Hello".
5. Next, search for another bot called **@userinfobot** or **@chatIDrobot** and start a chat with it. It will instantly reply with your personal **Chat ID** (a string of numbers).
6. Open your StudyLock Settings panel, paste the Token and Chat ID into the Telegram section, and hit **Test Alert** to verify the connection is working!

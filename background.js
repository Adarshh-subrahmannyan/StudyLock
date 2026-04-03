/**
 * StudyLock – background.js  (Firefox, Manifest V2, persistent background page)
 *
 * Blocking model  ──  WHITELIST  (with YouTube channel-level granularity)
 * ─────────────────────────────────────────────────────────────────────────────
 *  • During a session every main-frame navigation is intercepted.
 *  • If the destination URL's origin IS on the whitelist  →  allow it through
 *    (with one exception: youtube.com gets special per-channel handling, see §).
 *  • If the destination URL's origin is NOT on the whitelist  →  redirect to
 *    blocked.html?url=<encoded-url>&reason=blocked.
 *  • When no session is active the listener is a no-op (all tabs are free).
 *
 * § YouTube channel-level blocking
 * ─────────────────────────────────────────────────────────────────────────────
 *  Adding "youtube.com" to the whitelist does NOT grant free access to all
 *  of YouTube.  Instead, the separate `allowedYouTubeChannels` list controls
 *  which channel URLs are permitted:
 *
 *    Allowed channel path formats:
 *      "@PhysicsWallah"        → matches /watch?... only if  ?list= or the
 *                                  path starts with /@PhysicsWallah
 *      "/c/Unacademy"          → /c/Unacademy/**
 *      "/channel/<id>"         → /channel/<id>/**
 *      "/user/<name>"          → /user/<name>/**
 *
 *    Always blocked on YouTube (even with channel entries):
 *      /  (homepage)   /shorts/**   /results?*  (search)
 *      /feed/**        /trending    /gaming
 *
 *    Redirect reason for blocked YouTube: "ytblocked"
 *
 * Storage schema  (browser.storage.local)
 * ─────────────────────────────────────────────────────────────────────────────
 *  active                  {boolean}   Is a lock session running right now?
 *  startTime               {number}    Epoch-ms when the current session began.
 *  duration                {number}    Session length in minutes.
 *  whitelist               {string[]}  Bare domain strings the user may visit.
 *  allowedYouTubeChannels  {string[]}  Channel paths/handles that are permitted
 *                                      when youtube.com is in the whitelist.
 *                                      e.g. ["@PhysicsWallah", "/c/Unacademy"]
 *  activityLog             {Entry[]}   Rolling 7-day tab activity log.
 *                                      Each entry: {
 *                                        url, title, domain,
 *                                        timestampStart, timestampEnd,
 *                                        duration  (ms),
 *                                        status    ("whitelisted"|"blocked"|"free"),
 *                                        date      ("YYYY-MM-DD" UTC)
 *                                      }
 *
 * Built-in entries (always allowed, never blocked)
 * ─────────────────────────────────────────────────────────────────────────────
 *  • moz-extension://…  (this extension's own pages)
 *  • localhost / 127.0.0.1 / ::1
 *  • about:  chrome:  data:  javascript:  (browser internals)
 */

"use strict";

// ─── Constants ────────────────────────────────────────────────────────────────

const BLOCKED_PAGE = browser.runtime.getURL("blocked.html");
const ALARM_END = "studylock-session-end";
const ALARM_REMIND = "studylock-reminder";
const ALARM_POMO_BREAK = "studylock-pomo-break";    // fires after 25 min study
const ALARM_POMO_RESUME = "studylock-pomo-resume";   // fires after 5 min break
const NOTIF_ID = "studylock-notification";

/** Pomodoro durations (minutes) */
const POMO_STUDY_MIN = 25;
const POMO_BREAK_MIN = 5;

/** Streak threshold — must reach this many ms of focus in a day to count */
const STREAK_THRESHOLD_MS = 60 * 60 * 1000;   // 1 hour

/**
 * Domains that are ALWAYS permitted regardless of session state.
 * These protect the user from locking themselves out of essential browser UI.
 */
const ALWAYS_ALLOWED_SCHEMES = new Set(["moz-extension:", "about:", "chrome:", "data:", "javascript:"]);

const ALWAYS_ALLOWED_DOMAINS = [
  "localhost",
  "127.0.0.1",
  "::1",
];

// ─── Storage helpers ──────────────────────────────────────────────────────────

/** Canonical default shape for storage.local */
const STATE_DEFAULTS = Object.freeze({
  // ── Session ──────────────────────────────────────────────
  active: false,
  startTime: null,
  duration: 0,
  whitelist: [],   // bare domain strings the user may visit
  allowedYouTubeChannels: [],   // channel handles/paths allowed on YouTube

  // ── Pomodoro ─────────────────────────────────────────────
  pomodoroEnabled: false,       // is pomodoro cycling active for this session?
  pomodoroPhase: "study",     // "study" | "break"
  pomodoroRound: 0,           // how many study rounds have completed

  // ── Streak ───────────────────────────────────────────────
  streakCount: 0,            // consecutive calendar days with ≥1h focus
  streakLastDate: "",           // "YYYY-MM-DD" of last day streak was earned
});

/**
 * Read the full persisted state.
 * Falls back to STATE_DEFAULTS for any key not yet written.
 * @returns {Promise<{active:boolean, startTime:number|null, duration:number, whitelist:string[]}>}
 */
async function loadState() {
  return browser.storage.local.get({ ...STATE_DEFAULTS });
}

/**
 * Merge a partial object into storage.local.
 * @param {Partial<typeof STATE_DEFAULTS>} patch
 */
async function saveState(patch) {
  await browser.storage.local.set(patch);
}

// ─── Domain normalisation ─────────────────────────────────────────────────────

/**
 * Strip scheme, "www.", path, query, and port from any URL string or bare domain.
 * Returns an empty string if the URL is unparseable.
 *
 * Examples
 *   "https://www.youtube.com/watch?v=xyz" → "youtube.com"
 *   "stackoverflow.com"                   → "stackoverflow.com"
 *   "http://localhost:3000"               → "localhost"
 *
 * @param {string} input  URL or bare hostname
 * @returns {string}
 */
function normalizeDomain(input) {
  let hostname = "";
  try {
    // If it already has a scheme this will work directly.
    // If it's a bare domain (no scheme), prepend https:// so URL() can parse it.
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    hostname = url.hostname.toLowerCase();
  } catch {
    hostname = input.trim().toLowerCase();
  }
  return hostname.replace(/^www\./, "");
}

// ─── YouTube channel-level blocking ──────────────────────────────────────────

/**
 * YouTube hostnames we treat as "YouTube" for channel-level filtering.
 * This covers music.youtube.com, m.youtube.com etc.
 */
const YT_HOSTNAMES = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);

/**
 * URL pathname prefixes that are ALWAYS blocked on YouTube, even if a channel
 * list is configured.  Evaluated before channel matching.
 *
 * Each entry is a string prefix.  A URL path matches if it equals the entry
 * exactly OR starts with the entry followed by '/' or '?'.
 */
const YT_ALWAYS_BLOCKED_PATHS = [
  "/",            // homepage (exact)
  "/feed",        // /feed/subscriptions, /feed/trending, etc.
  "/results",     // search results  (/results?search_query=…)
  "/shorts",      // Shorts (/shorts/<id>)
  "/trending",    // legacy trending page
  "/gaming",      // gaming hub
  "/explore",     // explore tab
];

/**
 * Normalise a raw channel entry from the allowedYouTubeChannels array so it
 * can be reliably compared against a URL pathname.
 *
 * Supported input formats → stored/matched as:
 *   "@PhysicsWallah"       →  "/@physicsWallah"   (handle — case-preserved)
 *   "/c/Unacademy"         →  "/c/unacademy"
 *   "c/Unacademy"          →  "/c/unacademy"
 *   "/channel/UCxxxxx"     →  "/channel/ucxxxxx"
 *   "/user/someuser"       →  "/user/someuser"
 *
 * @param {string} raw
 * @returns {string}  Normalised path prefix (starts with '/'), or "" on error.
 */
function normalizeYTChannel(raw) {
  if (!raw || typeof raw !== "string") return "";
  let s = raw.trim();

  // Handle-style:  "@Foo"  →  "/@Foo" (preserve original casing for handles)
  if (s.startsWith("@")) return "/" + s;

  // Ensure leading slash
  if (!s.startsWith("/")) s = "/" + s;

  return s.toLowerCase();
}

/**
 * Decide whether a YouTube URL is permitted given the allowedYouTubeChannels
 * list.
 *
 * Decision flow:
 *  1. If allowedYouTubeChannels is empty → block all of YouTube.
 *  2. If the path matches an ALWAYS_BLOCKED prefix → block.
 *  3. If the path starts with an allowed channel prefix → allow.
 *  4. Anything else (/watch?v=… not under an allowed channel) → block.
 *
 * @param {string}   url      Full URL string being navigated to.
 * @param {string[]} channels Raw entries from allowedYouTubeChannels storage.
 * @returns {{ allowed: boolean, reason: string }}
 */
function isYouTubeAllowed(url, channels) {
  // No channels configured → treat YouTube as fully blocked
  if (!channels || channels.length === 0) {
    return { allowed: false, reason: "ytblocked" };
  }

  let pathname = "";
  let searchParams;
  try {
    const parsed = new URL(url);
    pathname = parsed.pathname.toLowerCase();   // e.g. "/@physicsWallah" → lower
    searchParams = parsed.searchParams;
  } catch {
    return { allowed: false, reason: "ytblocked" };
  }

  // ── Step 2: Hard-blocked paths ────────────────────────────────────────────
  for (const blocked of YT_ALWAYS_BLOCKED_PATHS) {
    if (
      pathname === blocked ||
      pathname.startsWith(blocked + "/") ||
      pathname.startsWith(blocked + "?")
    ) {
      // Special-case: /watch is allowed only when under a channel (handled below)
      // so we only reject here for the explicit always-blocked list.
      return { allowed: false, reason: "ytblocked" };
    }
  }

  // ── Step 3: Allowed channel prefix check ─────────────────────────────────
  //
  // Also allow /watch?v=… when the video's list parameter belongs to an
  // allowed channel.  We can't verify that from the URL alone, so we permit
  // any /watch URL that is NOT on the always-blocked list — the user must
  // pair /watch access with a channel entry intentionally.
  //
  // Acceptable channel path formats:
  //   /@handle/**          handle pages and their videos
  //   /c/<name>/**         custom URL channels
  //   /channel/<id>/**     channel-id URLs
  //   /user/<name>/**      legacy /user URLs
  //
  // Additionally, /watch?v=* is permitted when at least one channel is
  // whitelisted, because YouTube doesn't embed channel info in /watch URLs.
  //
  if (pathname === "/watch" && searchParams && searchParams.has("v")) {
    // Allow watch pages when channel list is non-empty (cannot verify channel
    // from URL alone; user opts in by adding any channel entry).
    return { allowed: true, reason: "" };
  }

  const normalised = channels.map(normalizeYTChannel).filter(Boolean);

  for (const channelPrefix of normalised) {
    if (
      pathname === channelPrefix.toLowerCase() ||
      pathname.startsWith(channelPrefix.toLowerCase() + "/") ||
      pathname.startsWith(channelPrefix.toLowerCase() + "?")
    ) {
      return { allowed: true, reason: "" };
    }
  }

  // ── Step 4: Nothing matched → block ──────────────────────────────────────
  return { allowed: false, reason: "ytblocked" };
}

// ─── Whitelist matching ───────────────────────────────────────────────────────

/**
 * Return an object describing whether a URL should be allowed through.
 *
 * Allow rules (checked in order):
 *  1. Scheme is in ALWAYS_ALLOWED_SCHEMES  (moz-extension, about, etc.)
 *  2. The URL is (or starts with) BLOCKED_PAGE itself — prevent redirect loops
 *  3. Hostname is in ALWAYS_ALLOWED_DOMAINS  (localhost, 127.0.0.1, ::1)
 *  4a. Host is a YouTube domain AND "youtube.com" is in the whitelist
 *      → delegate to isYouTubeAllowed() for channel-level filtering.
 *  4b. General whitelist check:
 *       - exact match:     "stackoverflow.com" matches "stackoverflow.com"
 *       - subdomain match: "docs.google.com"   matches "google.com"
 *
 * @param {string}   url       Full URL string from webRequest
 * @param {string[]} whitelist Array of bare domain strings
 * @param {string[]} ytChannels Allowed YouTube channel handles/paths
 * @returns {{ allowed: boolean, reason: string }}
 *   reason is "" when allowed, "blocked" for generic block, "ytblocked" for YouTube.
 */
function isAllowed(url, whitelist, ytChannels) {
  // ── 1. Internal / special schemes ────────────────────────────────────────
  let parsedScheme = "";
  try { parsedScheme = new URL(url).protocol; } catch { return { allowed: true, reason: "" }; }

  if (ALWAYS_ALLOWED_SCHEMES.has(parsedScheme)) return { allowed: true, reason: "" };

  // ── 2. Avoid redirect loop ────────────────────────────────────────────────
  if (url.startsWith(BLOCKED_PAGE)) return { allowed: true, reason: "" };

  // ── 3. Always-allowed hostnames ───────────────────────────────────────────
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return { allowed: true, reason: "" }; }

  if (ALWAYS_ALLOWED_DOMAINS.includes(host)) return { allowed: true, reason: "" };

  // ── 4a. YouTube — channel-level check ────────────────────────────────────
  //
  // Activate only when:
  //   (a) the host is a YouTube hostname, AND
  //   (b) the user has "youtube.com" in their whitelist.
  //
  // If youtube.com is NOT in the whitelist, the site falls through to 4b
  // and is blocked as normal.
  const normalHost = host.replace(/^www\./, "");
  const ytInWhitelist = whitelist.some(e => normalizeDomain(e) === "youtube.com");

  if (YT_HOSTNAMES.has(host) && ytInWhitelist) {
    return isYouTubeAllowed(url, ytChannels || []);
  }

  // ── 4b. General whitelist check ───────────────────────────────────────────
  const allowed = whitelist.some(entry => {
    const normalEntry = normalizeDomain(entry);
    if (!normalEntry) return false;
    return normalHost === normalEntry || normalHost.endsWith(`.${normalEntry}`);
  });

  return { allowed, reason: allowed ? "" : "blocked" };
}

// ─── webRequest interceptor ───────────────────────────────────────────────────

/**
 * The core blocking listener, registered on all <all_urls> main-frame requests.
 *
 * The MV2 webRequest "blocking" option requires the background page to be
 * *persistent* (set in manifest.json → background.persistent: true).
 *
 * We return a Promise so the decision is always async-safe.  Firefox MV2
 * supports returning Promises from "blocking" listeners.
 *
 * @param {browser.webRequest.onBeforeRequest.details} details
 * @returns {Promise<browser.webRequest.BlockingResponse>}
 */
function onBeforeRequest(details) {
  return (async () => {
    const { active, whitelist, allowedYouTubeChannels, pomodoroPhase } = await loadState();

    // Session not active → allow everything
    if (!active) return {};

    // ── Pomodoro break: all tabs are free ────────────────────────────────────
    // During a 5-min break the student is rewarded with unrestricted access.
    if (pomodoroPhase === "break") return {};

    // Study phase → run whitelist + YouTube channel check
    const { allowed, reason } = isAllowed(
      details.url,
      whitelist,
      allowedYouTubeChannels
    );

    if (allowed) return {};

    // Build redirect URL.
    // reason=ytblocked  → blocked.html shows YouTube-specific message.
    // reason=blocked    → blocked.html shows generic message.
    const destination =
      BLOCKED_PAGE +
      "?url=" + encodeURIComponent(details.url) +
      "&reason=" + encodeURIComponent(reason || "blocked");

    console.log(`[StudyLock] ${reason === "ytblocked" ? "YT-blocked" : "Blocked"}: ${details.url}`);
    return { redirectUrl: destination };
  })();
}

// Register the listener once (persistent page guarantees it stays active).
browser.webRequest.onBeforeRequest.addListener(
  onBeforeRequest,
  {
    urls: ["<all_urls>"],   // intercept every URL …
    types: ["main_frame", "sub_frame"], // … but only top-level and iframe navigations
  },
  ["blocking"]               // "blocking" lets us redirect synchronously
);

// ─── Session management ───────────────────────────────────────────────────────

/**
 * Begin a study session.
 *
 * @param {number}   durationMinutes         How long the session should run.
 * @param {string[]} whitelist               Domains the user is allowed to visit.
 * @param {string[]} allowedYouTubeChannels  Channel handles/paths allowed on YT.
 */
/**
 * Begin a study session.
 *
 * @param {number}   durationMinutes         Total session wall-clock length.
 * @param {string[]} whitelist               Domains the user may visit.
 * @param {string[]} allowedYouTubeChannels  Channel handles/paths allowed on YT.
 * @param {boolean}  pomodoroEnabled         Enable 25/5 pomodoro cycling.
 */
async function startSession(
  durationMinutes,
  whitelist,
  allowedYouTubeChannels = [],
  pomodoroEnabled = false
) {
  const startTime = Date.now();

  await saveState({
    active: true,
    startTime,
    duration: durationMinutes,
    whitelist,
    allowedYouTubeChannels,
    pomodoroEnabled,
    pomodoroPhase: "study",
    pomodoroRound: 0,
  });

  // Clear ALL old alarms before registering new ones
  await browser.alarms.clear(ALARM_END);
  await browser.alarms.clear(ALARM_REMIND);
  await browser.alarms.clear(ALARM_POMO_BREAK);
  await browser.alarms.clear(ALARM_POMO_RESUME);

  // Session end alarm (always)
  browser.alarms.create(ALARM_END, { delayInMinutes: durationMinutes });

  const ytNote = allowedYouTubeChannels.length > 0
    ? ` YouTube: ${allowedYouTubeChannels.length} channel(s) allowed.`
    : whitelist.includes("youtube.com") ? " YouTube fully blocked." : "";

  if (pomodoroEnabled) {
    // First study→break transition fires in POMO_STUDY_MIN minutes
    browser.alarms.create(ALARM_POMO_BREAK, { delayInMinutes: POMO_STUDY_MIN });
    notify(
      "🍅 StudyLock – Pomodoro Started",
      `Round 1 of ${Math.floor(durationMinutes / (POMO_STUDY_MIN + POMO_BREAK_MIN))} · ` +
      `${POMO_STUDY_MIN}m study → ${POMO_BREAK_MIN}m break.${ytNote} 💪`
    );
  } else {
    // Simple reminder every 25 min for longer sessions
    if (durationMinutes > 25) {
      browser.alarms.create(ALARM_REMIND, { periodInMinutes: 25 });
    }
    notify(
      "🔒 StudyLock – Session Started",
      `${durationMinutes}-min focus block active. ` +
      `${whitelist.length} site(s) whitelisted.${ytNote} 💪`
    );
  }

  console.log(
    `[StudyLock] Session started – ${durationMinutes} min | pomo=${pomodoroEnabled} | ` +
    `whitelist: [${whitelist.join(", ")}] | YT channels: [${allowedYouTubeChannels.join(", ")}]`
  );
}

/**
 * End a study session (naturally or manually).
 *
 * @param {"completed"|"manual"} reason
 */
async function endSession(reason = "completed") {
  await saveState({
    active: false,
    startTime: null,
    duration: 0,
    pomodoroPhase: "study",
    pomodoroRound: 0,
    pomodoroEnabled: false,
  });
  await browser.alarms.clear(ALARM_END);
  await browser.alarms.clear(ALARM_REMIND);
  await browser.alarms.clear(ALARM_POMO_BREAK);
  await browser.alarms.clear(ALARM_POMO_RESUME);

  // Update streak before clearing state
  await checkAndUpdateStreak();

  const message = reason === "completed"
    ? "✅ Session complete! Great work – check your streak!"
    : "🔓 Session ended early. Stay consistent!";

  notify("StudyLock", message);
  console.log(`[StudyLock] Session ended – reason: ${reason}`);
}

// ─── Pomodoro transition functions ──────────────────────────────────────────

/**
 * Called when a study round finishes.  Switches to break phase.
 * All blocking is lifted in onBeforeRequest while pomodoroPhase === "break".
 */
async function startPomodoroBreak() {
  const { active, pomodoroRound = 0 } = await loadState();
  if (!active) return;

  await saveState({ pomodoroPhase: "break" });
  await browser.alarms.clear(ALARM_POMO_BREAK);   // safety
  browser.alarms.create(ALARM_POMO_RESUME, { delayInMinutes: POMO_BREAK_MIN });

  const round = pomodoroRound + 1;
  notify(
    "☕ StudyLock – Break Time!",
    `Round ${round} complete! ${POMO_BREAK_MIN}-min break. ` +
    `All sites are unlocked — step away from the desk! 🧘`
  );
  console.log(`[StudyLock:pomo] Break started (after round ${round})`);
}

/**
 * Called when a break round finishes.  Resumes study phase + blocking.
 */
async function resumePomodoroStudy() {
  const { active, pomodoroRound = 0 } = await loadState();
  if (!active) return;

  const newRound = pomodoroRound + 1;
  await saveState({ pomodoroPhase: "study", pomodoroRound: newRound });
  await browser.alarms.clear(ALARM_POMO_RESUME);   // safety
  browser.alarms.create(ALARM_POMO_BREAK, { delayInMinutes: POMO_STUDY_MIN });

  notify(
    "📚 StudyLock – Back to Work!",
    `Break over. Round ${newRound + 1} starting. ` +
    `${POMO_STUDY_MIN}m of focused study. You've got this! 💪`
  );
  console.log(`[StudyLock:pomo] Study resumed – round ${newRound + 1}`);
}

// ─── Streak management ────────────────────────────────────────────────────────

/**
 * YYYY-MM-DD UTC string for an epoch-ms timestamp.
 * Mirrors toDateString() in the activity-tracking section.
 */
function streakDateStr(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-` +
    `${(d.getUTCMonth() + 1).toString().padStart(2, "0")}-` +
    `${d.getUTCDate().toString().padStart(2, "0")}`;
}

/**
 * Check today's focus time and advance / reset the streak accordingly.
 *
 * Rules:
 *  • Today's whitelisted-visit ms ≥ STREAK_THRESHOLD_MS (1h) → streak eligible.
 *    - streakLastDate === yesterday  → increment streak, update date.
 *    - streakLastDate === today      → already counted, no change.
 *    - anything else (gap / first)   → reset to 1, update date.
 *  • Below threshold:
 *    - streakLastDate < yesterday    → streak broken, reset to 0.
 *    - otherwise                     → no change (student may still reach 1h).
 */
async function checkAndUpdateStreak() {
  try {
    const { activityLog = [] } = await browser.storage.local.get("activityLog");
    const { streakCount = 0, streakLastDate = "" } = await loadState();

    const todayStr = streakDateStr(Date.now());
    const yesterdayStr = streakDateStr(Date.now() - 86_400_000);

    // Sum whitelisted duration for today
    const todayFocusMs = activityLog
      .filter(e => e.date === todayStr && e.status === "whitelisted")
      .reduce((s, e) => s + (e.duration || 0), 0);

    if (todayFocusMs >= STREAK_THRESHOLD_MS) {
      // Earned today
      if (streakLastDate === todayStr) {
        // Already counted — nothing to do
      } else if (streakLastDate === yesterdayStr) {
        // Consecutive day — extend streak
        await saveState({ streakCount: streakCount + 1, streakLastDate: todayStr });
        console.log(`[StudyLock:streak] Extended to ${streakCount + 1} days 🔥`);
      } else {
        // Gap or first day — start fresh streak
        await saveState({ streakCount: 1, streakLastDate: todayStr });
        console.log(`[StudyLock:streak] New streak started (was ${streakCount})`);
      }
    } else {
      // Haven't hit threshold yet today
      if (streakLastDate && streakLastDate < yesterdayStr && streakCount > 0) {
        // Missed a day — streak broken
        await saveState({ streakCount: 0 });
        console.log(`[StudyLock:streak] Streak reset (last date: ${streakLastDate})`);
      }
    }
  } catch (err) {
    console.warn("[StudyLock:streak] checkAndUpdateStreak error:", err.message);
  }
}

// ─── Alarm handler ────────────────────────────────────────────────────────────

browser.alarms.onAlarm.addListener(async alarm => {
  switch (alarm.name) {

    // ── Session end ─────────────────────────────────────────────────────────
    case ALARM_END:
      await endSession("completed");
      break;

    // ── Non-pomodoro reminder ────────────────────────────────────────────────
    case ALARM_REMIND: {
      const { active, startTime, duration } = await loadState();
      if (!active || !startTime) return;
      const elapsedMin = Math.round((Date.now() - startTime) / 60_000);
      const remainingMin = Math.max(0, duration - elapsedMin);
      notify(
        "📚 StudyLock – Keep Going!",
        `~${remainingMin} minute${remainingMin !== 1 ? "s" : ""} left. You've got this!`
      );
      break;
    }

    // ── Pomodoro: study round finished → start break ──────────────────────
    case ALARM_POMO_BREAK: {
      const { active, pomodoroEnabled } = await loadState();
      if (!active || !pomodoroEnabled) break;
      await startPomodoroBreak();
      break;
    }

    // ── Pomodoro: break finished → resume study ───────────────────────────
    case ALARM_POMO_RESUME: {
      const { active, pomodoroEnabled } = await loadState();
      if (!active || !pomodoroEnabled) break;
      await resumePomodoroStudy();
      break;
    }
  }
});

// ─── Notifications ────────────────────────────────────────────────────────────

/**
 * Display a browser notification.  Reuses NOTIF_ID so rapid calls don't stack.
 *
 * @param {string} title
 * @param {string} message
 */
function notify(title, message) {
  browser.notifications.create(NOTIF_ID, {
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/icon128.png"),
    title,
    message,
  });
}

// ─── Activity tracking ────────────────────────────────────────────────────────
//
// We use three event sources to build a complete picture:
//
//  tabs.onActivated     – user switches to a different tab
//  tabs.onUpdated       – URL/title changes inside the currently active tab
//  windows.onFocusChanged – browser window gains / loses focus
//
// For each "visit" we store one Entry.  An entry is OPEN while the tab is
// active and CLOSED (timestampEnd / duration set) when:
//   • Another tab becomes active in the same window
//   • The window loses focus
//   • The URL of the current tab navigates away
//   • The browser is about to close (onSuspend)
//
// ─────────────────────────────────────────────────────────────────────────────

/** How many milliseconds worth of history to keep (7 days). */
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * In-memory cursor for the current open tab visit.
 * Cleared when the visit is finalised and written to storage.
 *
 * @type {{ tabId:number, windowId:number, url:string, title:string,
 *          domain:string, startMs:number } | null}
 */
let currentVisit = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Return a YYYY-MM-DD string (UTC) for a given epoch-ms timestamp. */
function toDateString(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const D = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${D}`;
}

/**
 * Extract a bare, www-stripped domain from a URL string.
 * Returns "" for unparseable / internal URLs.
 */
function extractDomain(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Determine visit status at the moment it is closed.
 *
 * - "free"        → no active session; student was free to browse
 * - "whitelisted" → session active, URL passed isAllowed()
 * - "blocked"     → session active, URL was redirected by onBeforeRequest
 *                   (we infer this from the URL being blocked.html)
 *
 * @param {string} url
 * @param {boolean} sessionActive
 * @param {string[]} whitelist
 * @param {string[]} ytChannels
 * @returns {"free"|"whitelisted"|"blocked"}
 */
function classifyVisit(url, sessionActive, whitelist, ytChannels) {
  if (!sessionActive) return "free";
  if (url.startsWith(BLOCKED_PAGE)) return "blocked";
  const { allowed } = isAllowed(url, whitelist, ytChannels);
  return allowed ? "whitelisted" : "blocked";
}

// ── Storage I/O ───────────────────────────────────────────────────────────────

/** Load the activity log array from storage (never throws). */
async function loadLog() {
  try {
    const { activityLog = [] } = await browser.storage.local.get("activityLog");
    return Array.isArray(activityLog) ? activityLog : [];
  } catch {
    return [];
  }
}

/**
 * Append one closed entry to the log, then prune entries older than 7 days.
 * @param {object} entry  Completed visit entry.
 */
async function appendAndPrune(entry) {
  const log = await loadLog();
  const cutoff = Date.now() - LOG_RETENTION_MS;

  // Push the new entry, then drop anything older than the cutoff
  log.push(entry);
  const pruned = log.filter(e => (e.timestampEnd ?? e.timestampStart) >= cutoff);

  await browser.storage.local.set({ activityLog: pruned });
}

// ── Core: finalise the current open visit ────────────────────────────────────

/**
 * Close the current open visit, compute its duration, classify it, and
 * persist it to the activity log.  Safe to call when currentVisit is null.
 *
 * @param {number} [endMs]  Override end timestamp (defaults to Date.now()).
 */
async function finaliseVisit(endMs = Date.now()) {
  if (!currentVisit) return;

  const visit = currentVisit;
  currentVisit = null;   // Clear immediately to avoid double-finalise races

  // Skip internal / empty URLs – not useful to log
  const skip = ["", "about:blank", "about:newtab", "about:home"];
  if (!visit.url || skip.includes(visit.url)) return;
  try {
    const scheme = new URL(visit.url).protocol;
    if (ALWAYS_ALLOWED_SCHEMES.has(scheme)) return;
  } catch { return; }

  const durationMs = Math.max(0, endMs - visit.startMs);

  // Classification uses current session state
  const { active, whitelist = [], allowedYouTubeChannels = [] } = await loadState();
  const status = classifyVisit(visit.url, active, whitelist, allowedYouTubeChannels);

  const entry = {
    url: visit.url,
    title: visit.title || "",
    domain: visit.domain || extractDomain(visit.url),
    timestampStart: visit.startMs,
    timestampEnd: endMs,
    duration: durationMs,
    status,
    date: toDateString(visit.startMs),
  };

  await appendAndPrune(entry);
  console.log(`[StudyLock:log] ${status.toUpperCase()} ${entry.domain} (${Math.round(durationMs / 1000)}s)`);
}

// ── Open a new visit for the given tab ───────────────────────────────────────

/**
 * Start tracking a new tab visit.  Finalises any currently open visit first.
 *
 * @param {number} tabId
 * @param {number} windowId
 * @param {string} url
 * @param {string} title
 */
async function openVisit(tabId, windowId, url, title) {
  // Always close the previous visit before opening a new one
  await finaliseVisit();

  // Do not track internal / empty pages
  const skip = ["", "about:blank", "about:newtab", "about:home"];
  if (!url || skip.includes(url)) return;
  try {
    const scheme = new URL(url).protocol;
    if (ALWAYS_ALLOWED_SCHEMES.has(scheme)) return;
  } catch { return; }

  currentVisit = {
    tabId,
    windowId,
    url,
    title,
    domain: extractDomain(url),
    startMs: Date.now(),
  };
}

// ── Tab event listeners ───────────────────────────────────────────────────────

/**
 * User switches to a different tab.
 * Finalise the previous visit and open a new one for the newly active tab.
 */
browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  try {
    const tab = await browser.tabs.get(tabId);
    await openVisit(tabId, windowId, tab.url || "", tab.title || "");
  } catch (err) {
    console.warn("[StudyLock:log] onActivated error:", err.message);
  }
});

/**
 * URL or title changes in a tab.
 * If the changed tab is the current one we're tracking, finalise the old
 * entry and start a fresh one for the new URL.
 */
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only care about complete navigations (not intermediate loading states)
  if (changeInfo.status !== "complete") return;
  if (!tab.active) return;                        // Only track the active tab

  // If the URL or title actually changed, rotate the visit
  const urlChanged = currentVisit && currentVisit.url !== tab.url;
  const isFirstVisit = !currentVisit || currentVisit.tabId !== tabId;

  if (urlChanged || isFirstVisit) {
    await openVisit(tabId, tab.windowId, tab.url || "", tab.title || "");
  } else if (currentVisit && changeInfo.title) {
    // Title updated, keep the visit open but patch the title
    currentVisit.title = changeInfo.title;
  }
}, { properties: ["status", "title", "url"] });

/**
 * Browser window gains / loses focus. (Desktop only API)
 * When focus is lost (-1 = WINDOW_ID_NONE) finalise the current visit so
 * idle time is not recorded as tab activity.
 */
if (browser.windows && browser.windows.onFocusChanged) {
  browser.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === browser.windows.WINDOW_ID_NONE) {
      // Browser lost focus — close the current visit
      await finaliseVisit();
    } else {
      // Browser regained focus — open a visit for whichever tab is active
      try {
        const [activeTab] = await browser.tabs.query({ active: true, windowId });
        if (activeTab) {
          await openVisit(activeTab.id, windowId, activeTab.url || "", activeTab.title || "");
        }
      } catch (err) {
        console.warn("[StudyLock:log] onFocusChanged error:", err.message);
      }
    }
  });
}

/**
 * Best-effort flush when the extension is suspended / browser closes.
 */
browser.runtime.onSuspend.addListener(() => {
  finaliseVisit();   // fire-and-forget; storage flush is async but usually completes
});

// ── Public query helper (also exposed via message bus) ────────────────────────

/**
 * Return all activity log entries for a given calendar day.
 *
 * @param {Date|string} date  A Date object  OR  a "YYYY-MM-DD" string (UTC).
 * @returns {Promise<object[]>}  Array of log entries for that day, newest first.
 */
async function getLogs(date) {
  const target = typeof date === "string" ? date : toDateString(date.getTime());
  const log = await loadLog();
  return log
    .filter(e => e.date === target)
    .sort((a, b) => b.timestampStart - a.timestampStart);
}

// ─── Message bus  (popup.js ↔ background.js) ──────────────────────────────────

/**
 * Supported message types
 * ───────────────────────────────────────────────────────────────────────────
 *  GET_STATE
 *    → { active, startTime, duration, whitelist, allowedYouTubeChannels, elapsed }
 *
 *  START_SESSION  { duration: number, whitelist: string[], ytChannels?: string[] }
 *    → { ok: true }
 *
 *  STOP_SESSION
 *    → { ok: true }
 *
 *  ADD_DOMAIN       { domain: string }
 *    → { ok: true, whitelist: string[] }
 *
 *  REMOVE_DOMAIN    { domain: string }
 *    → { ok: true, whitelist: string[] }
 *
 *  GET_WHITELIST
 *    → { whitelist: string[] }
 *
 *  ADD_YT_CHANNEL    { channel: string }   e.g. "@PhysicsWallah" or "/c/Unacademy"
 *    → { ok: true, allowedYouTubeChannels: string[] }
 *
 *  REMOVE_YT_CHANNEL { channel: string }
 *    → { ok: true, allowedYouTubeChannels: string[] }
 *
 *  GET_YT_CHANNELS
 *    → { allowedYouTubeChannels: string[] }
 *
 *  GET_ACTIVITY_LOG  { date?: string }  (YYYY-MM-DD, defaults to today UTC)
 *    → { ok: true, logs: Entry[], date: string }
 *
 *  GET_FULL_LOG
 *    → { ok: true, logs: Entry[] }  (all retained entries, newest first)
 */
browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Wrap everything in an IIFE so we can use async/await while still
  // returning `true` synchronously to keep the channel open.
  (async () => {
    try {
      switch (msg.type) {

        // ── Read state ────────────────────────────────────────────────────
        case "GET_STATE": {
          // Also run streak check so popup always shows up-to-date streak
          await checkAndUpdateStreak();
          const state = await loadState();
          const elapsed = state.active && state.startTime
            ? Math.floor((Date.now() - state.startTime) / 1000)
            : 0;
          // Compute phase-remaining for popup countdown accuracy
          // (how many seconds until the current pomo phase ends)
          let phaseRemainSec = null;
          if (state.active && state.pomodoroEnabled) {
            const alarm = await browser.alarms.get(
              state.pomodoroPhase === "study" ? ALARM_POMO_BREAK : ALARM_POMO_RESUME
            );
            if (alarm) {
              phaseRemainSec = Math.max(0, Math.round((alarm.scheduledTime - Date.now()) / 1000));
            }
          }
          sendResponse({ ...state, elapsed, phaseRemainSec });
          break;
        }

        // ── GET_STREAK ────────────────────────────────────────────────────
        case "GET_STREAK": {
          await checkAndUpdateStreak();
          const { streakCount = 0, streakLastDate = "" } = await loadState();
          // Compute today's progress toward the 1h threshold
          const todayStr = streakDateStr(Date.now());
          const { activityLog = [] } = await browser.storage.local.get("activityLog");
          const todayMs = activityLog
            .filter(e => e.date === todayStr && e.status === "whitelisted")
            .reduce((s, e) => s + (e.duration || 0), 0);
          sendResponse({ ok: true, streakCount, streakLastDate, todayMs, thresholdMs: STREAK_THRESHOLD_MS });
          break;
        }

        // ── Session control ───────────────────────────────────────────────
        case "START_SESSION": {
          const wl = Array.isArray(msg.whitelist) ? msg.whitelist : [];
          const ytC = Array.isArray(msg.ytChannels) ? msg.ytChannels : [];
          const pomo = msg.pomodoroEnabled === true;
          await startSession(msg.duration, wl, ytC, pomo);
          sendResponse({ ok: true });
          break;
        }

        case "STOP_SESSION":
          await endSession("manual");
          sendResponse({ ok: true });
          break;

        // ── Whitelist CRUD ────────────────────────────────────────────────
        case "ADD_DOMAIN": {
          const domain = normalizeDomain(msg.domain || "");
          if (!domain) { sendResponse({ ok: false, error: "Empty domain" }); break; }

          const { whitelist } = await loadState();
          if (!whitelist.includes(domain)) {
            whitelist.push(domain);
            await saveState({ whitelist });
          }
          sendResponse({ ok: true, whitelist });
          break;
        }

        case "REMOVE_DOMAIN": {
          const domain = normalizeDomain(msg.domain || "");
          const { whitelist } = await loadState();
          const updated = whitelist.filter(d => d !== domain);
          await saveState({ whitelist: updated });
          sendResponse({ ok: true, whitelist: updated });
          break;
        }

        case "GET_WHITELIST": {
          const { whitelist } = await loadState();
          sendResponse({ whitelist });
          break;
        }

        // ── YouTube channel CRUD ──────────────────────────────────────────
        case "ADD_YT_CHANNEL": {
          const raw = (msg.channel || "").trim();
          if (!raw) { sendResponse({ ok: false, error: "Empty channel" }); break; }

          // Normalise — but store in the user's original casing for display.
          // We lowercased only during matching, not storage.
          const { allowedYouTubeChannels: ytList } = await loadState();
          // Deduplicate by normalised form
          const normNew = normalizeYTChannel(raw);
          const alreadyExists = ytList.some(c => normalizeYTChannel(c) === normNew);
          if (!alreadyExists) {
            ytList.push(raw);   // keep original casing for display
            await saveState({ allowedYouTubeChannels: ytList });
          }
          sendResponse({ ok: true, allowedYouTubeChannels: ytList });
          break;
        }

        case "REMOVE_YT_CHANNEL": {
          const raw = (msg.channel || "").trim();
          const normTarget = normalizeYTChannel(raw);
          const { allowedYouTubeChannels: ytList } = await loadState();
          const updated = ytList.filter(c => normalizeYTChannel(c) !== normTarget);
          await saveState({ allowedYouTubeChannels: updated });
          sendResponse({ ok: true, allowedYouTubeChannels: updated });
          break;
        }

        case "GET_YT_CHANNELS": {
          const { allowedYouTubeChannels } = await loadState();
          sendResponse({ allowedYouTubeChannels });
          break;
        }

        // ── Activity log queries ───────────────────────────────────────────
        case "GET_ACTIVITY_LOG": {
          // date defaults to today UTC if not supplied
          const dateStr = msg.date || toDateString(Date.now());
          const logs = await getLogs(dateStr);
          sendResponse({ ok: true, logs, date: dateStr });
          break;
        }

        case "GET_FULL_LOG": {
          const allLogs = await loadLog();
          // Return newest-first
          const sorted = [...allLogs].sort((a, b) => b.timestampStart - a.timestampStart);
          sendResponse({ ok: true, logs: sorted });
          break;
        }

        // ── Unknown ───────────────────────────────────────────────────────
        default:
          console.warn("[StudyLock] Unknown message type:", msg.type);
          sendResponse({ ok: false, error: `Unknown type: ${msg.type}` });
      }
    } catch (err) {
      console.error("[StudyLock] Message handler error:", err);
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // ← MUST return true to keep the response channel open
});

// ─── Startup ──────────────────────────────────────────────────────────────────

/**
 * On browser/extension restart, check if a session was active.
 * If the stored end-time has already passed, auto-end the session cleanly.
 */
browser.runtime.onStartup.addListener(async () => {
  const { active, startTime, duration } = await loadState();
  if (!active || !startTime) return;

  const sessionEndMs = startTime + duration * 60_000;
  const nowMs = Date.now();

  if (nowMs >= sessionEndMs) {
    // Session should have ended while the browser was closed
    console.log("[StudyLock] Cleaning up expired session from previous browser run.");
    await endSession("completed");
  } else {
    // Re-register the end alarm (alarms don't persist across browser restarts)
    const remainingMin = Math.ceil((sessionEndMs - nowMs) / 60_000);
    browser.alarms.create(ALARM_END, { delayInMinutes: remainingMin });
    console.log(`[StudyLock] Session restored – ${remainingMin} min left.`);
  }
});

console.log("[StudyLock] Background script loaded ✓");

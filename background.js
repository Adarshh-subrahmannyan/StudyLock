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

  // ── Telegram Alerts ──────────────────────────────────────
  telegramAlertsEnabled: false,
  telegramToken: "",
  telegramChatId: "",

  // ── Daily Goals ──────────────────────────────────────────
  dailyGoal: null,    // { date: "YYYY-MM-DD", goalText: "", targetHours: 0, subject: "", completed: false }
  goalsHistory: [],   // Array of dailyGoal objects

  // ── Smart Breaks ──────────────────────────────────────────
  smartBreakActive: false,
  smartBreaksCount: 0,
  smartBreaksTotalMins: 0,

  // ── Night Study Warnings ─────────────────────────────────
  nightWarningsEnabled: true,
  nightWarningTime: "23:00",
  nightForceEndEnabled: false,
  nightForceEndTime: "01:00",
  nightTelegramEnabled: false,

  // ── Parental Controls ────────────────────────────────────
  strictLockdownEnabled: false,
  sessionStartTelegram: false,
  sessionEndTelegram: false
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
  // If the user whitelisted youtube.com but specified no custom channels,
  // we assume they want full unrestricted access to YouTube.
  if (!channels || channels.length === 0) {
    return { allowed: true, reason: "" };
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

// ─── Telegram Alerts ──────────────────────────────────────────────────────────

const lastAlertTimes = {}; // domain -> timestamp

async function triggerTelegramAlert(url, sessionStartTimeMs) {
  const domain = normalizeDomain(url) || url;
  const now = Date.now();

  if (lastAlertTimes[domain] && (now - lastAlertTimes[domain]) < 5 * 60 * 1000) {
    return; // Max 1 alert per site per 5 minutes
  }
  // Immediately record time to prevent async race condition when multiple subframes load
  lastAlertTimes[domain] = now;

  try {
    const state = await loadState();
    if (!state.telegramAlertsEnabled || !state.telegramToken || !state.telegramChatId) return;



    const dateObj = new Date();
    const timeStr = dateObj.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const dateStr = dateObj.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    const activeMinutes = Math.floor((now - sessionStartTimeMs) / 60000);

    const text = `⚠️ StudyLock Alert!\n👤 Student tried to open: ${domain}\n⏰ Time: ${timeStr}\n📅 Date: ${dateStr}\n📚 Session was active for: ${activeMinutes} minutes\n🔒 Site was blocked successfully`;

    const apiUrl = `https://api.telegram.org/bot${state.telegramToken}/sendMessage`;

    await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: state.telegramChatId,
        text: text
      })
    });
  } catch (err) {
    console.warn("[StudyLock] Failed to send Telegram alert:", err);
  }
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
function addMinutes(timeStr, mins) {
  let [h, m] = timeStr.split(':').map(Number);
  m += mins; h += Math.floor(m / 60);
  m = m % 60; h = h % 24;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

function onBeforeRequest(details) {
  return (async () => {
    const { active, startTime, whitelist, allowedYouTubeChannels, pomodoroPhase, smartBreakActive, nightForceEndEnabled, nightForceEndTime, strictLockdownEnabled } = await loadState();

    const now = new Date();
    const currentHHMM = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    const isBetween = (curr, start, end) => {
      if (start < end) return curr >= start && curr < end;
      return curr >= start || curr < end;
    };

    if (nightForceEndEnabled && nightForceEndTime && isBetween(currentHHMM, nightForceEndTime, "06:00")) {
      // Prevent redirect loops for internal/extension pages
      let parsedScheme = "";
      try { parsedScheme = new URL(details.url).protocol; } catch { }

      if (!details.url.startsWith(BLOCKED_PAGE) && !ALWAYS_ALLOWED_SCHEMES.has(parsedScheme)) {
        const destination = BLOCKED_PAGE + "?url=" + encodeURIComponent(details.url) + "&reason=nightlock";
        return { redirectUrl: destination };
      }
    }

    // Session not active
    if (!active) {
      if (!strictLockdownEnabled) return {};

      // Strict Lockdown Mode: check if URL is natively allowed (extension pages/localhost)
      const { allowed } = isAllowed(details.url, [], []);
      if (allowed) return {};

      const destination = BLOCKED_PAGE + "?url=" + encodeURIComponent(details.url) + "&reason=blocked";
      return { redirectUrl: destination };
    }

    // ── Pomodoro break: all tabs are free ────────────────────────────────────
    // During a 5-min break the student is rewarded with unrestricted access.
    if (pomodoroPhase === "break" || smartBreakActive) return {};

    // Study phase → run whitelist + YouTube channel check
    const { allowed, reason } = isAllowed(
      details.url,
      whitelist,
      allowedYouTubeChannels
    );

    if (allowed) return {};

    // Trigger Telegram Alert (if enabled)
    triggerTelegramAlert(details.url, startTime);

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

// ─── Activity Tracking (Smart Breaks) ────────────────────────────────────────

let tabSwitches = [];
browser.tabs.onActivated.addListener(async (activeInfo) => {
  const { active, pomodoroPhase, smartBreakActive } = await loadState();
  if (!active || pomodoroPhase === "break" || smartBreakActive) return;

  const now = Date.now();
  tabSwitches.push(now);
  tabSwitches = tabSwitches.filter(t => now - t <= 5 * 60 * 1000);

  if (tabSwitches.length > 8) {
    tabSwitches = [];
    try {
      await browser.tabs.sendMessage(activeInfo.tabId, { type: "SUGGEST_BREAK" });
    } catch (_) { }
  }
});

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

  const { sessionStartTelegram, telegramToken, telegramChatId } = await loadState();
  if (sessionStartTelegram && telegramToken && telegramChatId) {
    const text = `🔒 StudyLock Session Started!\n⏳ Duration: ${durationMinutes} minutes\n✅ Whitelisted sites: ${whitelist.length}`;
    fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: telegramChatId, text })
    }).catch(() => null);
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
  const { startTime, sessionEndTelegram, telegramToken, telegramChatId } = await loadState();
  const sessionBegun = startTime || Date.now();

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

  if (sessionEndTelegram && telegramToken && telegramChatId) {
    await finaliseVisit(Date.now()); // ensure current active tab is logged
    const logs = await loadLog();
    const sessionVisits = logs.filter(l => l.timestampStart >= sessionBegun && l.status !== "free");

    const domainTimes = {};
    for (const v of sessionVisits) {
      domainTimes[v.domain] = (domainTimes[v.domain] || 0) + v.duration;
    }

    let sitesList = Object.entries(domainTimes)
      .sort((a, b) => b[1] - a[1])
      .map(([d, t]) => `- ${d}: ${Math.max(1, Math.round(t / 60000))}m`)
      .join("\n");

    if (!sitesList) sitesList = "No activity recorded.";

    const text = `✅ StudyLock Session Ended!\nReason: ${reason}\n\nVisited Sites:\n${sitesList}`;
    fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: telegramChatId, text })
    }).catch(() => null);
  }
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

// ─── Daily Goals ──────────────────────────────────────────────────────────────

/**
 * Check if the user needs to set a goal for today.
 * If no goal is set for today, pop up the goal overlay.
 */
async function checkDailyGoal() {
  const { dailyGoal } = await loadState();
  const todayStr = streakDateStr(Date.now());

  if (!dailyGoal || dailyGoal.date !== todayStr) {
    // Need to set a new goal
    try {
      await browser.windows.create({
        url: browser.runtime.getURL("goal.html"),
        type: "popup",
        width: 440,
        height: 600
      });
    } catch (err) {
      console.warn("[StudyLock] Fallback: opening goal as tab. (Android/Unsupported environment)", err);
      // Fallback for Android (which doesn't support type: "popup" or multiple windows cleanly)
      await browser.tabs.create({ url: browser.runtime.getURL("goal.html") });
    }
  }

  // Also ensure the 9 PM alarm is set for today/tomorrow
  setup9PMAlarm();
}

/**
 * Schedule the next 9 PM alarm
 */
function setup9PMAlarm() {
  const now = new Date();
  let target = new Date(now);
  target.setHours(21, 0, 0, 0);

  if (now > target) {
    target.setDate(target.getDate() + 1);
  }

  const delayMs = target.getTime() - now.getTime();
  browser.alarms.create("studylock-9pm-goal", { when: Date.now() + delayMs });
}

// Run on startup / installation
browser.runtime.onStartup.addListener(checkDailyGoal);
browser.runtime.onInstalled.addListener(checkDailyGoal);

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

    // ── 9 PM Goal Check ─────────────────────────────────────────────────────
    case "studylock-9pm-goal": {
      const { dailyGoal } = await loadState();
      const todayStr = streakDateStr(Date.now());
      if (dailyGoal && dailyGoal.date === todayStr && !dailyGoal.completed) {
        browser.notifications.create("studylock-goal-check", {
          type: "basic",
          iconUrl: browser.runtime.getURL("icons/icon128.png"),
          title: "StudyLock - Goal Check",
          message: `Did you complete your goal today?\n"${dailyGoal.goalText}"`,
          buttons: [
            { title: "✅ Yes" },
            { title: "❌ No" }
          ]
        });
      }
      setup9PMAlarm(); // schedule next 9pm
      break;
    }

    // ── Smart Break End ───────────────────────────────────────────────────────
    case "studylock-smart-break-end": {
      await saveState({ smartBreakActive: false });
      // Notify all tabs to remove overlay
      try {
        const tabs = await browser.tabs.query({});
        for (let t of tabs) {
          browser.tabs.sendMessage(t.id, { type: "END_SMART_BREAK" }).catch(() => null);
        }
      } catch (e) { }
      notify("StudyLock", "Break over! Back to work 💪");
      break;
    }

    // ── Night Warnings Check ──────────────────────────────────────────────────
    case "studylock-minute-tick": {
      const state = await loadState();

      const now = new Date();
      const currentHHMM = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

      const isBetween = (curr, start, end) => {
        if (start < end) return curr >= start && curr < end;
        return curr >= start || curr < end;
      };

      if (state.nightForceEndEnabled && state.nightForceEndTime && isBetween(currentHHMM, state.nightForceEndTime, "06:00")) {
        if (state.active) {
          await endSession("night");
          notify("StudyLock", "Session ended. Please sleep. Good night! 🌙");
          try {
            const tabs = await browser.tabs.query({});
            for (let t of tabs) {
              browser.tabs.sendMessage(t.id, { type: "NIGHT_WARNING", level: 4 }).catch(() => null);
            }
          } catch (e) { }
        }
      } else if (state.active && state.nightWarningsEnabled) {
        const wTime = state.nightWarningTime || "23:00";
        if (currentHHMM === wTime) {
          notify("StudyLock", "🌙 It's getting late. Consider wrapping up.");
          try {
            const tabs = await browser.tabs.query({});
            for (let t of tabs) browser.tabs.sendMessage(t.id, { type: "NIGHT_WARNING", level: 1 }).catch(() => null);
          } catch (e) { }
        } else if (currentHHMM === addMinutes(wTime, 30)) {
          try {
            const tabs = await browser.tabs.query({});
            for (let t of tabs) browser.tabs.sendMessage(t.id, { type: "NIGHT_WARNING", level: 2 }).catch(() => null);
          } catch (e) { }
        } else if (currentHHMM === addMinutes(wTime, 90)) {
          try {
            const tabs = await browser.tabs.query({});
            for (let t of tabs) browser.tabs.sendMessage(t.id, { type: "NIGHT_WARNING", level: 3 }).catch(() => null);
          } catch (e) { }

          if (state.nightTelegramEnabled && state.telegramToken && state.telegramChatId) {
            const apiUrl = `https://api.telegram.org/bot${state.telegramToken}/sendMessage`;
            fetch(apiUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: state.telegramChatId, text: "🌙 Alert: Student is still studying at warning level 3. Consider checking on them." })
            }).catch(() => null);
          }
        }
      }
      break;
    }
  }
});

browser.alarms.create("studylock-minute-tick", { periodInMinutes: 1 });

// Notifications Button Handler
browser.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
  if (notifId === "studylock-goal-check") {
    const { dailyGoal, goalsHistory = [] } = await loadState();
    if (dailyGoal) {
      dailyGoal.completed = (btnIdx === 0);

      // Update history if today exists
      const hIdx = goalsHistory.findIndex(g => g.date === dailyGoal.date);
      if (hIdx >= 0) {
        goalsHistory[hIdx] = dailyGoal;
      } else {
        goalsHistory.push(dailyGoal);
      }

      await saveState({ dailyGoal, goalsHistory });
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

        // ── GOAL_CREATED ──────────────────────────────────────────────────
        case "GOAL_CREATED": {
          const { goalsHistory = [] } = await loadState();
          const goal = msg.goal;
          // check if today's goal already exists in history (shouldn't usually)
          const hIdx = goalsHistory.findIndex(g => g.date === goal.date);
          if (hIdx >= 0) {
            goalsHistory[hIdx] = goal;
          } else {
            goalsHistory.push(goal);
          }
          await saveState({ dailyGoal: goal, goalsHistory });
          sendResponse({ ok: true });
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

        case "START_SMART_BREAK": {
          const { active, startTime, smartBreaksCount = 0, smartBreaksTotalMins = 0 } = await loadState();
          if (!active) { sendResponse({ ok: false }); break; }
          const duration = msg.duration || 5;
          const studyTimeBeforeBreak = Math.round((Date.now() - startTime) / 60000);

          await saveState({
            smartBreakActive: true,
            smartBreaksCount: smartBreaksCount + 1,
            smartBreaksTotalMins: smartBreaksTotalMins + studyTimeBeforeBreak
          });

          browser.alarms.create("studylock-smart-break-end", { delayInMinutes: duration });
          sendResponse({ ok: true });
          break;
        }

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

        // ── Telegram Settings ─────────────────────────────────────────────
        case "UPDATE_TELEGRAM": {
          await saveState({
            telegramAlertsEnabled: msg.enabled,
            telegramToken: msg.token || "",
            telegramChatId: msg.chatId || ""
          });
          sendResponse({ ok: true });
          break;
        }

        case "TEST_TELEGRAM": {
          const { telegramToken, telegramChatId } = await loadState();
          if (!telegramToken || !telegramChatId) {
            sendResponse({ ok: false, error: "Settings incomplete" });
            break;
          }
          const apiUrl = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
          try {
            const res = await fetch(apiUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: telegramChatId,
                text: "🔔 StudyLock: This is a test alert! Your Telegram integration is working."
              })
            });
            if (res.ok) {
              sendResponse({ ok: true });
            } else {
              sendResponse({ ok: false, error: "Telegram API rejected the request." });
            }
          } catch (err) {
            sendResponse({ ok: false, error: err.message });
          }
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

        // ── Settings ───────────────────────────────────────────────────────
        case "UPDATE_NIGHT_SETTINGS":
        case "UPDATE_PARENTAL_CONTROLS":
          await saveState(msg.settings);
          sendResponse({ ok: true });
          break;

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

const PORTAL_PATTERN = "https://portal.freedomforever.com/*";
const ALL_PROJECTS_RUNNER_URL = "http://127.0.0.1:8775/all-projects-supervisor.mjs";
const WATCHDOG_ALARM = "portal-backfill-watchdog";
const ALL_PROJECTS_RUNNER_VERSION = 9;
const STALLED_AFTER_MS = 3 * 60 * 1000;
const RELOAD_COOLDOWN_MS = 45 * 1000;

function now() { return Date.now(); }

async function mark(tabId, text, color) {
  await chrome.action.setBadgeText({ tabId, text }).catch(() => undefined);
  if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => undefined);
}

async function cooldownActive(tabId) {
  const key = `reload-${tabId}`;
  const saved = await chrome.storage.session.get(key);
  return Number(saved[key] || 0) > now() - RELOAD_COOLDOWN_MS;
}

async function reloadPortal(tabId, why) {
  if (await cooldownActive(tabId)) return;
  await chrome.storage.session.set({ [`reload-${tabId}`]: now() });
  await mark(tabId, "FIX", "#b26a00");
  console.warn("Reloading Portal backfill tab:", why);
  await chrome.tabs.reload(tabId).catch(error => console.warn("Portal reload failed", error));
}

async function health(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const allProjects = window.__freedomAllProjectsSupervisor;
      return {
        allProjects: {
          version: Number(allProjects?.version || 0),
          running: Boolean(allProjects?.running),
          complete: Boolean(allProjects?.complete),
          lastProgressAt: Number(allProjects?.lastProgressAt || 0),
        },
        url: location.href,
      };
    },
  });
  return result?.result ?? {
    allProjects: { running: false, complete: false, lastProgressAt: 0 },
  };
}

async function injectRunner(tabId, source, label) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (source, label) => {
      try {
        await import(`${source}?watchdog=${Date.now()}`);
      } catch (error) {
        console.warn(`Portal watchdog could not start ${label}`, error);
        throw error;
      }
    },
    args: [source, label],
  });
}

async function watchTab(tab) {
  if (!tab.id || !tab.url?.startsWith("https://portal.freedomforever.com/")) return;
  try {
    const state = await health(tab.id);
    if ((state.allProjects.running || state.allProjects.complete) && state.allProjects.version !== ALL_PROJECTS_RUNNER_VERSION) {
      await reloadPortal(tab.id, "a newer all-projects runner is available");
      return;
    }
    const allProjectsHealthy = state.allProjects.running && state.allProjects.lastProgressAt > now() - STALLED_AFTER_MS;
    if (state.allProjects.running && !allProjectsHealthy) {
      await reloadPortal(tab.id, "all-projects export made no progress for three minutes");
      return;
    }
    if (!state.allProjects.running && !state.allProjects.complete) {
      await injectRunner(tab.id, ALL_PROJECTS_RUNNER_URL, "the all-projects export");
    }
    await mark(tab.id, "RUN", "#167c2a");
  } catch (error) {
    console.warn("Portal watchdog health check failed", error);
    await reloadPortal(tab.id, "page or runner was unavailable");
  }
}

async function watchAllTabs() {
  const tabs = await chrome.tabs.query({ url: [PORTAL_PATTERN] });
  await Promise.all(tabs.map(watchTab));
}

async function initialize() {
  await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
  await watchAllTabs();
}

chrome.runtime.onInstalled.addListener(() => { initialize().catch(console.error); });
chrome.runtime.onStartup.addListener(() => { initialize().catch(console.error); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === WATCHDOG_ALARM) watchAllTabs().catch(console.error);
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === "complete" && tab.url?.startsWith("https://portal.freedomforever.com/")) {
    watchTab(tab).catch(console.error);
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove(`reload-${tabId}`).catch(() => undefined);
});

initialize().catch(console.error);

/* ══════════════════════════════════════════════════════════════
   BBC Dashboard — Service Worker
   Handles background notifications so reminders fire even when
   the app is closed or the screen is locked.
   ══════════════════════════════════════════════════════════════ */

const SW_VERSION = 'bbc-dashboard-sw-v1';
const APP_CACHE  = 'bbc-dashboard-cache-v1';

/* Files to cache for offline use */
const PRECACHE = ['./index.html'];

/* ── Install: cache the app shell ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

/* ── Activate: clean old caches, take control immediately ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== APP_CACHE).map(k => caches.delete(k))
      )
    ).then(() => {
      self.clients.claim();
      // Check for any overdue reminders as soon as SW activates
      return checkAndFireDueReminders();
    })
  );
});

/* ── Fetch: serve from cache when offline ── */
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

/* ══════════════════════════════════════════════════════════════
   REMINDER STORAGE
   Reminders are stored in a simple key-value store using the
   Cache API (available in SW context) as an IndexedDB-free
   persistence layer. Each entry is stored as a JSON Response.
   ══════════════════════════════════════════════════════════════ */

const REMINDER_STORE = 'bbc-reminders-v1';

async function getReminders() {
  try {
    const cache = await caches.open(REMINDER_STORE);
    const keys  = await cache.keys();
    const results = await Promise.all(
      keys.map(async req => {
        try {
          const res  = await cache.match(req);
          const data = await res.json();
          return data;
        } catch { return null; }
      })
    );
    return results.filter(Boolean);
  } catch { return []; }
}

async function saveReminder(reminder) {
  try {
    const cache = await caches.open(REMINDER_STORE);
    const url   = `https://bbc-dashboard-reminders/${reminder.id}`;
    const res   = new Response(JSON.stringify(reminder), {
      headers: { 'Content-Type': 'application/json' }
    });
    await cache.put(url, res);
  } catch (e) { console.error('[SW] saveReminder failed:', e); }
}

async function deleteReminder(id) {
  try {
    const cache = await caches.open(REMINDER_STORE);
    await cache.delete(`https://bbc-dashboard-reminders/${id}`);
  } catch { /* silent */ }
}

async function clearAllReminders() {
  try { await caches.delete(REMINDER_STORE); } catch { /* silent */ }
}

/* ══════════════════════════════════════════════════════════════
   FIRE OVERDUE REMINDERS
   Called on SW activate and after any message so that reminders
   missed while the SW was asleep are never silently dropped.
   ══════════════════════════════════════════════════════════════ */

async function checkAndFireDueReminders() {
  const now       = Date.now();
  const reminders = await getReminders();
  const due       = reminders.filter(r => r.fireAt <= now);

  for (const r of due) {
    await self.registration.showNotification('BBC Dashboard', {
      body:    r.body,
      icon:    './icon-192.png',
      badge:   './icon-192.png',
      tag:     r.id,           // deduplicates if fired more than once
      data:    { url: './' },
      requireInteraction: false,
    });
    await deleteReminder(r.id);
  }

  return due.length;
}

/* ══════════════════════════════════════════════════════════════
   IN-PROCESS TIMERS
   For reminders due soon (within the next 2 hours) the SW keeps
   a live setTimeout so the notification fires precisely on time
   without relying on the SW being woken up externally.
   ══════════════════════════════════════════════════════════════ */

const _swTimers = {};   // id → timer handle

async function rescheduleTimers() {
  const now       = Date.now();
  const reminders = await getReminders();

  // Cancel any existing timers for reminders no longer stored
  const ids = new Set(reminders.map(r => r.id));
  for (const [id, t] of Object.entries(_swTimers)) {
    if (!ids.has(id)) { clearTimeout(t); delete _swTimers[id]; }
  }

  for (const r of reminders) {
    if (_swTimers[r.id]) continue;   // already scheduled
    const delay = r.fireAt - now;

    if (delay <= 0) {
      // Overdue — fire immediately
      await self.registration.showNotification('BBC Dashboard', {
        body:  r.body,
        icon:  './icon-192.png',
        tag:   r.id,
        data:  { url: './' },
      });
      await deleteReminder(r.id);
    } else if (delay < 2 * 60 * 60 * 1000) {
      // Due within 2 hours — keep a live timer
      _swTimers[r.id] = setTimeout(async () => {
        await self.registration.showNotification('BBC Dashboard', {
          body:  r.body,
          icon:  './icon-192.png',
          tag:   r.id,
          data:  { url: './' },
        });
        await deleteReminder(r.id);
        delete _swTimers[r.id];
      }, delay);
    }
    // Reminders > 2 h away: stored in REMINDER_STORE, picked up when SW
    // next activates (triggered by opening the app or periodic background sync)
  }
}

/* ══════════════════════════════════════════════════════════════
   MESSAGE HANDLER
   The page sends messages here to schedule / cancel reminders.
   ══════════════════════════════════════════════════════════════ */

self.addEventListener('message', async event => {
  const { type, reminder, id } = event.data || {};

  if (type === 'SCHEDULE') {
    // reminder = { id, title, body, fireAt (ms timestamp) }
    if (!reminder || !reminder.id || !reminder.fireAt) return;
    await saveReminder(reminder);
    await rescheduleTimers();
    event.ports[0]?.postMessage({ ok: true });
  }

  else if (type === 'CANCEL') {
    if (!id) return;
    if (_swTimers[id]) { clearTimeout(_swTimers[id]); delete _swTimers[id]; }
    await deleteReminder(id);
    event.ports[0]?.postMessage({ ok: true });
  }

  else if (type === 'CANCEL_ALL') {
    Object.values(_swTimers).forEach(clearTimeout);
    Object.keys(_swTimers).forEach(k => delete _swTimers[k]);
    await clearAllReminders();
    event.ports[0]?.postMessage({ ok: true });
  }

  else if (type === 'PING') {
    // Page pings the SW periodically to keep it alive & check for overdue
    await checkAndFireDueReminders();
    await rescheduleTimers();
    event.ports[0]?.postMessage({ ok: true, ts: Date.now() });
  }
});

/* ══════════════════════════════════════════════════════════════
   NOTIFICATION CLICK
   Tapping the notification opens / focuses the dashboard.
   ══════════════════════════════════════════════════════════════ */

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        // If the app is already open, focus it
        for (const client of clients) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            return client.focus();
          }
        }
        // Otherwise open a new window
        if (self.clients.openWindow) return self.clients.openWindow(target);
      })
  );
});

import React, { useState, useEffect, useRef, useMemo } from 'react';
import ZipHeatMap, { aggregateCheckinsByZip } from './ZipHeatMap.js';
import PatternChart from './PatternChart.js';

// No JSX/build-step assumptions: everything is written with
// React.createElement so this file works as plain .js, unmodified,
// with any bundler (or none at all).
const e = React.createElement;

/*
 * Recycle Heroes! — single-screen prototype
 * Two functions only: check in an existing user, or register a new one.
 * All data lives in localStorage. No router, no other screens.
 */

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------
// {
//   username: string (unique),
//   email: string (valid email),
//   phone: string (valid US phone),
//   zip: string (5-digit ZIP, must be in DETROIT_ZIPS),
//   curbsideInterest: boolean,
//   noCurbsideAccess: boolean (optional — "I live somewhere with no curbside
//     recycling option," e.g. an apartment/multi-unit building) | undefined
//     — absent on records created before this field existed, same
//     missing-means-unknown treatment as registeredDate below.
//   buildingName: string (optional, only meaningful when noCurbsideAccess is
//     true — free text, not validated/normalized beyond a length cap, so
//     rollups by building need manual reconciliation of near-duplicates)
//     | undefined,
//   smsOptIn: boolean (optional — permission to text updates),
//   emailOptIn: boolean (optional — permission to email updates),
//   registeredDate: string ("YYYY-MM-DD", Eastern calendar day) | undefined
//     — set on every new registration going forward; absent on records
//     created before this field existed (never backfilled — there's no way
//     to know the real date), so trend/growth analysis should treat missing
//     as "unknown," not "day zero."
//   totalCheckins: number,
//   firstCheckinDate: string ("YYYY-MM-DD") | null,
//   lastCheckinDate: string ("YYYY-MM-DD") | null,
//   eventsAttended: string[] (event ids)
// }
//
// Check-in log (separate store, one record per check-in event):
// {
//   username: string,
//   dateKey: string ("YYYY-MM-DD", Eastern calendar day — enforces 1/day),
//   timestamp: string (ISO 8601, exact moment of check-in),
//   eventId: string | null (id of the event active at check-in time, if any)
// }
//
// Events (separate store, one record per created event):
// {
//   id: string ("evt_YYYYMMDD_NNN", auto-generated from the start date),
//   name: string,
//   startTime: string (ISO 8601),
//   endTime: string (ISO 8601, must be after startTime),
//   notes: string (optional)
// }
// The "current" event is whichever one's [startTime, endTime) window
// contains the current moment (checked every 30s — see the `now` state in
// App()), so event mode starts/ends automatically with no activate/switch
// step. Ending an event early (or deleting a never-started one) is a
// manual admin action; see handleEndEventNow / handleDeleteEvent.
//
// Visitors (separate store, event-mode-only — deliberately not merged with
// recycleHeroesUsers):
// {
//   id: string ("visitor_NNNN", auto-generated),
//   email: string,
//   phone: string (normalized, same shape as user records — this is the
//     match key for recognizing a returning visitor),
//   totalCheckins: number,
//   firstCheckinDate: string ("YYYY-MM-DD") | null,
//   lastCheckinDate: string ("YYYY-MM-DD") | null,
//   eventsAttended: string[] (event ids — at most one check-in per event)
// }
//
// Weight logs (separate store, one record per logged weigh-in — not tied to
// a specific user or shipment; each entry is the total weight (lbs) of a
// batch shipped out, a running log the org uses to track material shipped):
// {
//   weightLbs: number,
//   dateKey: string ("YYYY-MM-DD", Eastern calendar day),
//   timestamp: string (ISO 8601, exact moment logged)
// }

const STORAGE_KEY = 'recycleHeroesUsers';

// ---------------------------------------------------------------------------
// Theme — dark is the default; index.html applies the stored/default value
// to <html data-theme> before first paint to avoid a flash of the wrong one.
// ---------------------------------------------------------------------------

const THEME_STORAGE_KEY = 'recycleHeroesTheme';

function loadTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

// ---------------------------------------------------------------------------
// Storage logic
// ---------------------------------------------------------------------------

// Wraps every localStorage write so a quota-exceeded (or private-browsing/
// storage-disabled) failure is a catchable, loggable event instead of an
// uncaught exception mid-handler. The write silently not landing is still
// possible — there's no transaction to roll back to — but callers that
// actually need to know (see importStateFromFile) can check the return
// value instead of the app just throwing with no diagnosis.
function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    console.error(`Failed to save to localStorage (key: "${key}"):`, err);
    return false;
  }
}

function loadUsers() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveUsers(users) {
  return safeSetItem(STORAGE_KEY, JSON.stringify(users));
}

function findUserByUsername(users, username) {
  const target = username.trim().toLowerCase();
  return users.find((u) => u.username.toLowerCase() === target);
}

// Used by the Database panel's Users search (filterExplorerUsers, below)
// for the "I forgot my username" case: a typed phone number will rarely
// match the stored "XXX-XXX-XXXX"/"+1XXXXXXXXXX" shape character-for-
// character, so phone matching compares digits-only instead. The minimum
// digit count keeps a short/empty query (typed while entering an email,
// which has no digits at all) from matching every user — .includes('') is
// true for everything, so an unguarded check would.
const CONTACT_LOOKUP_MIN_PHONE_DIGITS = 4;

// Check-in log — separate from the user list so we can tell how many times
// someone has checked in (and on which day), not just whether they exist.
const CHECKINS_STORAGE_KEY = 'recycleHeroesCheckins';

function loadCheckins() {
  try {
    const raw = localStorage.getItem(CHECKINS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCheckins(checkins) {
  return safeSetItem(CHECKINS_STORAGE_KEY, JSON.stringify(checkins));
}

function hasCheckedInToday(checkins, username, dateKey) {
  const target = username.trim().toLowerCase();
  return checkins.some((c) => c.username.toLowerCase() === target && c.dateKey === dateKey);
}

// Admin-authored message of the day — plain string, empty means "no banner".
const MOTD_STORAGE_KEY = 'recycleHeroesMotd';

function loadMotd() {
  try {
    return localStorage.getItem(MOTD_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function saveMotd(motd) {
  return safeSetItem(MOTD_STORAGE_KEY, motd);
}

// Events — created from the admin panel's Event Mode section. The most
// recently created one is treated as "current" (see App() below).
const EVENTS_STORAGE_KEY = 'recycleHeroesEvents';

function loadEvents() {
  try {
    const raw = localStorage.getItem(EVENTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveEvents(events) {
  return safeSetItem(EVENTS_STORAGE_KEY, JSON.stringify(events));
}

// evt_YYYYMMDD_NNN, sequential per calendar day — keyed on the event's own
// start date (not creation time), so an event planned ahead of time gets an
// id matching the day it actually happens.
function generateEventId(existingEvents, startDate) {
  const datePart = `${startDate.getFullYear()}${String(startDate.getMonth() + 1).padStart(2, '0')}${String(
    startDate.getDate()
  ).padStart(2, '0')}`;
  const sameDayCount = existingEvents.filter((ev) => ev.id.startsWith(`evt_${datePart}_`)).length;
  return `evt_${datePart}_${String(sameDayCount + 1).padStart(3, '0')}`;
}

// An event is "current" while now falls in [startTime, endTime) — end is
// exclusive so manually setting endTime to "now" (End Event Now) takes
// effect immediately rather than leaving it active for one more instant.
function isEventActive(event, now) {
  if (!event.startTime || !event.endTime) return false;
  const start = new Date(event.startTime);
  const end = new Date(event.endTime);
  return now >= start && now < end;
}

// "Aug 2, 2:00 PM – 6:00 PM", or "Aug 2, 2:00 PM – Aug 3, 10:00 AM" for a
// window that spans midnight.
function formatEventWindow(event) {
  const start = new Date(event.startTime);
  const end = new Date(event.endTime);
  const sameDay = start.toDateString() === end.toDateString();
  const dateOpts = { month: 'short', day: 'numeric' };
  const timeOpts = { hour: 'numeric', minute: '2-digit' };
  const startStr = `${start.toLocaleDateString(undefined, dateOpts)}, ${start.toLocaleTimeString(undefined, timeOpts)}`;
  const endStr = sameDay
    ? end.toLocaleTimeString(undefined, timeOpts)
    : `${end.toLocaleDateString(undefined, dateOpts)}, ${end.toLocaleTimeString(undefined, timeOpts)}`;
  return `${startStr} – ${endStr}`;
}

// ---------------------------------------------------------------------------
// Visitors — a separate, event-mode-only store for people who check in via
// the "Visitor Check-In" flow (no username, just email + phone). Kept fully
// independent of `recycleHeroesUsers`: no lookups or merging between the two,
// by design ("a separate database").
// ---------------------------------------------------------------------------

const VISITORS_STORAGE_KEY = 'recycleHeroesVisitors';

function loadVisitors() {
  try {
    const raw = localStorage.getItem(VISITORS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveVisitors(visitors) {
  return safeSetItem(VISITORS_STORAGE_KEY, JSON.stringify(visitors));
}

function generateVisitorId(existingVisitors) {
  return `visitor_${String(existingVisitors.length + 1).padStart(4, '0')}`;
}

// A returning visitor is recognized by phone (already normalized to a
// canonical shape, so an exact match is reliable) rather than email, which
// is more prone to typos/variation across separate walk-up entries.
function findVisitorByPhone(visitors, phone) {
  return visitors.find((v) => v.phone === phone);
}

// Total visitor check-ins across every event that visitor has attended.
function totalVisitorCheckins(visitors) {
  return visitors.reduce((sum, v) => sum + (v.totalCheckins || 0), 0);
}

function countVisitorCheckinsForEvent(visitors, eventId) {
  if (!eventId) return 0;
  return visitors.filter((v) => Array.isArray(v.eventsAttended) && v.eventsAttended.includes(eventId)).length;
}

// Mirrors the two functions above, but for existing users' event check-ins.
// Those live in the shared `checkins` log (tagged with eventId — see
// handleCheckin's inEventMode branch), not in the visitors store, so event
// attendance stats need to fold both sources together to be accurate. A
// user's own totalCheckins can't stand in for the all-time count here since
// it also includes their regular walk-in check-ins, not just event ones.
function countUserCheckinsForEvent(checkins, eventId) {
  if (!eventId) return 0;
  return checkins.filter((c) => c.eventId === eventId).length;
}

function totalUserEventCheckins(checkins) {
  return checkins.filter((c) => c.eventId).length;
}

// ---------------------------------------------------------------------------
// Weight logs — logged from the Data Management panel. Just a flat,
// append-only log; nothing else in the app reads or dedupes against it.
// ---------------------------------------------------------------------------

const WEIGHTS_STORAGE_KEY = 'recycleHeroesWeights';

function loadWeights() {
  try {
    const raw = localStorage.getItem(WEIGHTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveWeights(weights) {
  return safeSetItem(WEIGHTS_STORAGE_KEY, JSON.stringify(weights));
}

function generateWeightId(existingWeights) {
  return `weight_${String(existingWeights.length + 1).padStart(4, '0')}`;
}

// A sanity ceiling, not a real operational limit — catches fat-fingered
// typos (e.g. 4250 instead of 425) rather than capping legitimate hauls.
// Log multiple entries if a single session genuinely exceeds this. Worth
// revisiting downward once real shipment sizes are known.
const MAX_WEIGHT_LBS = 10000;

// Shared by the log form and the inline edit form so both enforce the same
// rule with the same wording.
function parseWeightInput(raw) {
  const trimmed = String(raw).trim();
  const value = Number(trimmed);
  if (!trimmed || !Number.isFinite(value) || value <= 0) {
    return { error: 'Enter a weight in lbs greater than 0.' };
  }
  if (value > MAX_WEIGHT_LBS) {
    return { error: `That's above the ${MAX_WEIGHT_LBS.toLocaleString()} lbs sanity limit — double check the number.` };
  }
  return { value };
}

// Rounded to 1 decimal (matches the log form's step="0.1") to avoid
// floating-point noise (e.g. 42.5 + 10 rendering as 52.49999999999999).
function totalWeightLoggedLbs(weights) {
  const sum = weights.reduce((total, w) => total + (w.weightLbs || 0), 0);
  return Math.round(sum * 10) / 10;
}

// Fallback banner shown above check-in when the admin hasn't set a custom
// MOTD — same three totals as the Analytics stat tiles, computed live at
// render time (not stored), so it always reflects current data rather than
// whatever it happened to say the last time someone typed a message.
function defaultMotd(users, checkins, weights) {
  return `${users.length.toLocaleString()} Total Users • ${checkins.length.toLocaleString()} Total Check-ins • ${totalWeightLoggedLbs(weights).toLocaleString()} lbs Total Waste Diverted`;
}

// The most recently *concluded* event, excluding whichever one (if any) is
// currently active — used for the admin panel's "last event" stat.
function getMostPreviousEvent(events, currentEventId, now) {
  const ended = events.filter((ev) => ev.id !== currentEventId && new Date(ev.endTime) <= now);
  if (ended.length === 0) return null;
  return ended.reduce((latest, ev) => (new Date(ev.endTime) > new Date(latest.endTime) ? ev : latest));
}

// ---------------------------------------------------------------------------
// Leaderboard helpers
// ---------------------------------------------------------------------------

function topZipsByRegisteredUsers(users, limit) {
  const counts = {};
  users.forEach((user) => {
    if (!user.zip) return;
    counts[user.zip] = (counts[user.zip] || 0) + 1;
  });
  return Object.entries(counts)
    .map(([zip, count]) => ({ zip, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// Reuses aggregateCheckinsByZip (same function the heat map runs on) so
// this stays consistent with it — event-mode check-ins are excluded there
// since event attendance is tracked as a separate concern from regular
// per-ZIP walk-in activity, and this leaderboard should agree with the map.
function topZipsByActivity(users, checkins, limit) {
  const zipCounts = aggregateCheckinsByZip(checkins, users);
  return Object.entries(zipCounts)
    .filter(([, count]) => count > 0)
    .map(([zip, count]) => ({ zip, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function topUsersByCheckins(users, limit) {
  return [...users]
    .filter((user) => (user.totalCheckins || 0) > 0)
    .sort((a, b) => (b.totalCheckins || 0) - (a.totalCheckins || 0))
    .slice(0, limit);
}

// Frequency trend: check-ins in the most recent `windowDays` vs the
// `windowDays` immediately before that, per ZIP — surfaces which ZIPs have
// the least (or most sharply declining) recent participation, so outreach
// can be targeted geographically. Reuses aggregateCheckinsByZip (the same
// function the heat map runs on) for each window, so this stays consistent
// with it — event-mode check-ins excluded, users matched by username.
function zipParticipationTrends(users, checkins, now, windowDays, limit) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const currentStart = new Date(now.getTime() - windowDays * msPerDay);
  const previousStart = new Date(now.getTime() - windowDays * 2 * msPerDay);

  const currentCheckins = checkins.filter((c) => {
    const ts = new Date(c.timestamp);
    return ts >= currentStart && ts <= now;
  });
  const previousCheckins = checkins.filter((c) => {
    const ts = new Date(c.timestamp);
    return ts >= previousStart && ts < currentStart;
  });

  const currentByZip = aggregateCheckinsByZip(currentCheckins, users);
  const previousByZip = aggregateCheckinsByZip(previousCheckins, users);

  const registeredByZip = {};
  users.forEach((user) => {
    if (!user.zip) return;
    registeredByZip[user.zip] = (registeredByZip[user.zip] || 0) + 1;
  });

  // Only ZIPs with at least one registered user — an empty ZIP isn't a
  // participation problem, it's just nobody signed up from there yet.
  return Object.keys(registeredByZip)
    .map((zip) => {
      const current = currentByZip[zip] || 0;
      const previous = previousByZip[zip] || 0;
      return { zip, registered: registeredByZip[zip], current, previous, delta: current - previous };
    })
    .sort((a, b) => a.current - b.current || a.delta - b.delta)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Validation logic
// ---------------------------------------------------------------------------

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ZIP_REGEX = /^\d{5}$/;
const USERNAME_MIN_LENGTH = 5;
const USERNAME_MAX_LENGTH = 15;
// Letters/digits/underscore/hyphen only — usernames get typed at a kiosk
// under time pressure (no benefit to allowing symbols/spaces), get shown
// back verbatim in exports and the check-in log, and are the leading
// candidate for what eventually gets written onto an RFID card. (CSV
// formula injection is still guarded independently by escapeCsvField,
// since email isn't restricted enough to rule out a leading =/+/-/@.)
const USERNAME_REGEX = /^[A-Za-z0-9_-]+$/;

// Free text (building/property names don't fit a fixed list the way ZIPs
// do), so this is just a sanity cap against pasted junk — not a format
// restriction. CSV formula injection is still handled independently by
// escapeCsvField at export time, same as every other field.
const BUILDING_NAME_MAX_LENGTH = 100;

// Registration is scoped to Detroit — same list used by the heat map.
const DETROIT_ZIPS = [
  '48201', '48202', '48203', '48204', '48205',
  '48206', '48207', '48208', '48209', '48210',
  '48211', '48212', '48213', '48214', '48215',
  '48216', '48217', '48218', '48219', '48220',
  '48221', '48223', '48224', '48225', '48226',
  '48227', '48228', '48234', '48235', '48236',
  '48238', '48239', '48240',
];

// Canonical stored phone shapes: 10-digit US numbers become "XXX-XXX-XXXX";
// 11-digit numbers with a leading country code become "+1XXXXXXXXXX".
const NORMALIZED_PHONE_REGEX = /^(\d{3}-\d{3}-\d{4}|\+1\d{10})$/;

// Strips everything but digits, then maps to one of the two shapes above.
// Returns null if the digit count doesn't match a normalizable US number.
function normalizePhone(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits[0] === '1') {
    return `+1${digits.slice(1)}`;
  }
  return null;
}

// Only ever runs outside event mode now — the "New User Registration" form
// is fully replaced by Visitor Check-In (validateVisitorCheckin, below)
// while event mode is active, so there's no event-mode branch to carry here.
function validateRegistration(form, users) {
  const errors = {};

  const username = form.username.trim();
  if (!username) errors.username = 'Username is required.';
  else if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    errors.username = `Username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters.`;
  } else if (!USERNAME_REGEX.test(username)) {
    errors.username = 'Username can only contain letters, numbers, underscores, and hyphens.';
  } else if (findUserByUsername(users, form.username)) errors.username = 'That username is already taken.';

  if (!form.email.trim()) errors.email = 'Email is required.';
  else if (!EMAIL_REGEX.test(form.email.trim())) errors.email = 'Enter a valid email address.';

  if (!form.phone.trim()) errors.phone = 'Phone is required.';
  else if (!normalizePhone(form.phone)) errors.phone = 'Enter a valid US phone number.';

  if (!form.zip.trim()) errors.zip = 'ZIP code is required.';
  else if (!ZIP_REGEX.test(form.zip.trim())) errors.zip = 'ZIP code must be 5 digits.';
  else if (!DETROIT_ZIPS.includes(form.zip.trim())) errors.zip = 'Please enter a valid Detroit ZIP code.';

  // Only relevant (and only validated) when the "no curbside access"
  // checkbox is on — an empty/ignored buildingName otherwise is fine, that's
  // just someone who didn't opt into the follow-up detail.
  if (form.noCurbsideAccess && form.buildingName.trim().length > BUILDING_NAME_MAX_LENGTH) {
    errors.buildingName = `Building name must be ${BUILDING_NAME_MAX_LENGTH} characters or fewer.`;
  }

  return errors;
}

// Visitor Check-In (event mode only) — just email + phone, no username.
function validateVisitorCheckin(form) {
  const errors = {};

  if (!form.email.trim()) errors.email = 'Email is required.';
  else if (!EMAIL_REGEX.test(form.email.trim())) errors.email = 'Enter a valid email address.';

  if (!form.phone.trim()) errors.phone = 'Phone is required.';
  else if (!normalizePhone(form.phone)) errors.phone = 'Enter a valid US phone number.';

  return errors;
}

// ---------------------------------------------------------------------------
// Data integrity check (read-only, runs once on load — never blocks usage)
// ---------------------------------------------------------------------------

function validateUserRecord(user, index) {
  const label = `User #${index + 1}${user && typeof user.username === 'string' ? ` (${user.username})` : ''}`;
  if (!user || typeof user !== 'object') return [`${label}: record is not an object.`];

  const warnings = [];
  if (!user.username || typeof user.username !== 'string') {
    warnings.push(`${label}: missing or invalid username.`);
  } else if (user.username.length < USERNAME_MIN_LENGTH || user.username.length > USERNAME_MAX_LENGTH) {
    warnings.push(`${label}: username length out of range.`);
  } else if (!USERNAME_REGEX.test(user.username)) {
    warnings.push(`${label}: username contains characters outside letters/numbers/underscore/hyphen.`);
  }
  if (!user.email || !EMAIL_REGEX.test(user.email)) warnings.push(`${label}: invalid email.`);
  if (!user.phone || !NORMALIZED_PHONE_REGEX.test(user.phone)) {
    warnings.push(`${label}: invalid or unnormalized phone.`);
  }
  // Empty (not missing-and-invalid) ZIP is the expected state for event-mode
  // registrants — that flow doesn't collect one at all — so it's not flagged.
  // A non-empty but malformed/non-Detroit value is still a real data problem.
  if (user.zip && (!ZIP_REGEX.test(user.zip) || !DETROIT_ZIPS.includes(user.zip))) {
    warnings.push(`${label}: invalid ZIP code.`);
  }
  if (typeof user.curbsideInterest !== 'boolean') {
    warnings.push(`${label}: curbsideInterest is not a boolean.`);
  }
  // Missing entirely is expected on records created before this field
  // existed — only a present-but-malformed value is a real problem.
  if (user.registeredDate && !/^\d{4}-\d{2}-\d{2}$/.test(user.registeredDate)) {
    warnings.push(`${label}: invalid registeredDate.`);
  }
  // noCurbsideAccess/buildingName are newer than curbsideInterest — missing
  // entirely is expected on records that predate them, same treatment as
  // registeredDate above rather than curbsideInterest's always-boolean rule.
  if (user.noCurbsideAccess !== undefined && typeof user.noCurbsideAccess !== 'boolean') {
    warnings.push(`${label}: noCurbsideAccess is not a boolean.`);
  }
  if (user.buildingName !== undefined) {
    if (typeof user.buildingName !== 'string') {
      warnings.push(`${label}: buildingName is not a string.`);
    } else if (user.buildingName.length > BUILDING_NAME_MAX_LENGTH) {
      warnings.push(`${label}: buildingName exceeds ${BUILDING_NAME_MAX_LENGTH} characters.`);
    }
  }
  return warnings;
}

function validateCheckinRecord(checkin, index) {
  const label = `Check-in #${index + 1}`;
  if (!checkin || typeof checkin !== 'object') return [`${label}: record is not an object.`];

  const warnings = [];
  if (!checkin.username || typeof checkin.username !== 'string') {
    warnings.push(`${label}: missing or invalid username.`);
  }
  if (!checkin.dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(checkin.dateKey)) {
    warnings.push(`${label}: invalid dateKey.`);
  }
  if (!checkin.timestamp || Number.isNaN(Date.parse(checkin.timestamp))) {
    warnings.push(`${label}: invalid timestamp.`);
  }
  return warnings;
}

function validateVisitorRecord(visitor, index) {
  const label = `Visitor #${index + 1}`;
  if (!visitor || typeof visitor !== 'object') return [`${label}: record is not an object.`];

  const warnings = [];
  if (!visitor.id || typeof visitor.id !== 'string') warnings.push(`${label}: missing or invalid id.`);
  if (!visitor.email || !EMAIL_REGEX.test(visitor.email)) warnings.push(`${label}: invalid email.`);
  if (!visitor.phone || !NORMALIZED_PHONE_REGEX.test(visitor.phone)) {
    warnings.push(`${label}: invalid or unnormalized phone.`);
  }
  if (typeof visitor.totalCheckins !== 'number' || visitor.totalCheckins < 0) {
    warnings.push(`${label}: totalCheckins is not a valid number.`);
  }
  return warnings;
}

function validateEventRecord(event, index) {
  const label = `Event #${index + 1}${event && typeof event.name === 'string' ? ` (${event.name})` : ''}`;
  if (!event || typeof event !== 'object') return [`${label}: record is not an object.`];

  const warnings = [];
  if (!event.id || typeof event.id !== 'string') warnings.push(`${label}: missing or invalid id.`);
  if (!event.name || typeof event.name !== 'string') warnings.push(`${label}: missing name.`);
  const start = Date.parse(event.startTime);
  const end = Date.parse(event.endTime);
  if (!event.startTime || Number.isNaN(start)) warnings.push(`${label}: invalid startTime.`);
  if (!event.endTime || Number.isNaN(end)) warnings.push(`${label}: invalid endTime.`);
  if (!Number.isNaN(start) && !Number.isNaN(end) && end <= start) {
    warnings.push(`${label}: endTime must be after startTime.`);
  }
  return warnings;
}

function validateWeightRecord(weight, index) {
  const label = `Weight log #${index + 1}`;
  if (!weight || typeof weight !== 'object') return [`${label}: record is not an object.`];

  const warnings = [];
  if (typeof weight.weightLbs !== 'number' || !Number.isFinite(weight.weightLbs) || weight.weightLbs <= 0) {
    warnings.push(`${label}: weightLbs must be a positive number.`);
  } else if (weight.weightLbs > MAX_WEIGHT_LBS) {
    warnings.push(`${label}: weightLbs (${weight.weightLbs}) exceeds the ${MAX_WEIGHT_LBS.toLocaleString()} lbs sanity limit.`);
  }
  if (!weight.dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(weight.dateKey)) {
    warnings.push(`${label}: invalid dateKey.`);
  }
  if (!weight.timestamp || Number.isNaN(Date.parse(weight.timestamp))) {
    warnings.push(`${label}: invalid timestamp.`);
  }
  return warnings;
}

function runIntegrityCheck(users, checkins, visitors, events, weights) {
  const warnings = [];
  users.forEach((user, index) => warnings.push(...validateUserRecord(user, index)));
  checkins.forEach((checkin, index) => warnings.push(...validateCheckinRecord(checkin, index)));
  visitors.forEach((visitor, index) => warnings.push(...validateVisitorRecord(visitor, index)));
  events.forEach((event, index) => warnings.push(...validateEventRecord(event, index)));
  weights.forEach((weight, index) => warnings.push(...validateWeightRecord(weight, index)));
  return warnings;
}

// Only fixes issues with an unambiguous correct value: phones that are
// reformattable via normalizePhone, and non-boolean curbsideInterest flags.
// Missing/invalid email, ZIP, username, and checkin records are left alone —
// there's no safe way to infer what they should have been.
function autoFixUsers(users) {
  let fixedCount = 0;
  const fixedUsers = users.map((user) => {
    if (!user || typeof user !== 'object') return user;
    const fixed = { ...user };

    if (!fixed.phone || !NORMALIZED_PHONE_REGEX.test(fixed.phone)) {
      const normalized = normalizePhone(fixed.phone || '');
      if (normalized) {
        fixed.phone = normalized;
        fixedCount += 1;
      }
    }

    if (typeof fixed.curbsideInterest !== 'boolean') {
      fixed.curbsideInterest = Boolean(fixed.curbsideInterest);
      fixedCount += 1;
    }

    // Unlike curbsideInterest above, a genuinely missing noCurbsideAccess is
    // left alone (means "predates this field," not "false") — only a
    // present-but-wrong-type value gets coerced.
    if (fixed.noCurbsideAccess !== undefined && typeof fixed.noCurbsideAccess !== 'boolean') {
      fixed.noCurbsideAccess = Boolean(fixed.noCurbsideAccess);
      fixedCount += 1;
    }

    return fixed;
  });

  return { fixedUsers, fixedCount };
}

// Mirrors autoFixUsers' phone-normalization fix — visitors have no
// boolean-like field equivalent to curbsideInterest, so there's nothing
// else here that's safely auto-fixable.
function autoFixVisitors(visitors) {
  let fixedCount = 0;
  const fixedVisitors = visitors.map((visitor) => {
    if (!visitor || typeof visitor !== 'object') return visitor;
    const fixed = { ...visitor };

    if (!fixed.phone || !NORMALIZED_PHONE_REGEX.test(fixed.phone)) {
      const normalized = normalizePhone(fixed.phone || '');
      if (normalized) {
        fixed.phone = normalized;
        fixedCount += 1;
      }
    }

    return fixed;
  });

  return { fixedVisitors, fixedCount };
}

// Returns a copy of `user` with check-in history fields bumped. Used for
// both a normal check-in and registration's auto-check-in — same rules
// either way, so this is the one place that logic lives.
function applyCheckinToUser(user, dateKey, eventId) {
  const eventsAttended = Array.isArray(user.eventsAttended) ? user.eventsAttended : [];
  return {
    ...user,
    totalCheckins: (user.totalCheckins || 0) + 1,
    firstCheckinDate: user.firstCheckinDate || dateKey,
    lastCheckinDate: dateKey,
    eventsAttended: eventId && !eventsAttended.includes(eventId) ? [...eventsAttended, eventId] : eventsAttended,
  };
}

// ---------------------------------------------------------------------------
// Check-in hours (Eastern time — America/New_York, so this tracks EST/EDT
// automatically). Registration is NOT gated, only check-in.
// ---------------------------------------------------------------------------

const GRACE_MINUTES = 15;

// day: 0=Sun ... 6=Sat. Hours are in minutes-from-midnight, before grace.
const CHECKIN_WINDOWS = [
  { day: 1, startHour: 10, endHour: 18 }, // Monday 10am–6pm
  { day: 3, startHour: 10, endHour: 18 }, // Wednesday 10am–6pm
  { day: 6, startHour: 9, endHour: 15 }, // Saturday 9am–3pm
];

const CHECKIN_HOURS_TEXT = 'Mon & Wed 10am–6pm ET, Sat 9am–3pm ET';

// Constructing an Intl.DateTimeFormat is genuinely expensive — cheap to do
// once and reuse, very much not cheap to redo on every call. getEasternParts
// can run thousands of times in one pass (once per check-in, in the pattern
// analysis below), so a fresh formatter per call was a real hot spot.
const EASTERN_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: 'numeric',
  minute: 'numeric',
  hour12: false,
});

// Generalized so it can be re-run against any historical Date, not just
// "right now" — reused by the check-in pattern analysis below to recover
// the Eastern day-of-week/hour a past check-in actually happened at,
// consistently with how dateKey itself was derived at write time.
function getEasternParts(date) {
  const parts = EASTERN_TIME_FORMATTER.formatToParts(date);

  const byType = {};
  for (const part of parts) byType[part.type] = part.value;

  const weekdayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = weekdayIndex[byType.weekday];
  const hour = Number(byType.hour) % 24; // hour12:false can report "24" for midnight
  const minute = Number(byType.minute);
  const dateKey = `${byType.year}-${byType.month}-${byType.day}`; // Eastern calendar day

  return { day, hour, minutesSinceMidnight: hour * 60 + minute, dateKey };
}

function getEasternNow() {
  return getEasternParts(new Date());
}

function isCheckinOpen() {
  const { day, minutesSinceMidnight } = getEasternNow();
  return CHECKIN_WINDOWS.some((window) => {
    if (window.day !== day) return false;
    const start = window.startHour * 60 - GRACE_MINUTES;
    const end = window.endHour * 60 + GRACE_MINUTES;
    return minutesSinceMidnight >= start && minutesSinceMidnight <= end;
  });
}

// A typical visit is short — sorted materials don't take long to drop off,
// and time spent beyond that is usually just people socializing, not a
// meaningful signal — so a full hour is too coarse to see the actual
// arrival shape within a session. 15 minutes instead.
const CHECKIN_PATTERN_SLOT_MINUTES = 15;

function formatTimeSlotLabel(minutesSinceMidnight) {
  const hour24 = Math.floor(minutesSinceMidnight / 60);
  const minute = minutesSinceMidnight % 60;
  const period = hour24 < 12 ? 'am' : 'pm';
  const displayHour = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${displayHour}:${String(minute).padStart(2, '0')}${period}`;
}

// First-pass framework for surge/downtime planning, not a finished
// analysis — the shape (per-weekday, per-slot, averaged) is the part meant
// to last; the exact treatment is worth revisiting once there's enough
// real (non-test) data for the averages to mean something.
//
// Averaged per session (distinct dateKey of that weekday with at least one
// check-in) rather than a raw cumulative total, so this reflects "how busy
// is a typical Wednesday at 2pm" rather than just "how long has the org
// been running." Split by day-of-week rather than one pooled bucket, since
// Mon/Wed and Sat don't even share the same operating window. Event-mode
// check-ins are excluded — a one-off pop-up event doesn't reflect a
// "typical" regular session, same reasoning the heat map and leaderboard
// already apply to their own activity numbers.
function sessionCheckinPatterns(checkins) {
  const regular = checkins.filter((c) => !c.eventId);

  return CHECKIN_WINDOWS.map((window) => {
    const startMin = window.startHour * 60;
    const endMin = window.endHour * 60;
    const slotCounts = {};
    for (let m = startMin; m < endMin; m += CHECKIN_PATTERN_SLOT_MINUTES) slotCounts[m] = 0;

    const sessionDates = new Set();
    regular.forEach((c) => {
      const parts = getEasternParts(new Date(c.timestamp));
      if (parts.day !== window.day) return;
      sessionDates.add(c.dateKey);
      const slot = Math.floor(parts.minutesSinceMidnight / CHECKIN_PATTERN_SLOT_MINUTES) * CHECKIN_PATTERN_SLOT_MINUTES;
      if (slotCounts[slot] !== undefined) slotCounts[slot] += 1;
    });

    const sessionCount = sessionDates.size;
    return {
      day: window.day,
      sessionCount,
      slots: Object.keys(slotCounts)
        .map(Number)
        .sort((a, b) => a - b)
        .map((slot) => ({
          slot,
          total: slotCounts[slot],
          avg: sessionCount > 0 ? slotCounts[slot] / sessionCount : 0,
        })),
    };
  });
}

// ---------------------------------------------------------------------------
// Achievements (admin-only for now — an internal retention-analytics read on
// top of check-in history, not a user-facing feature yet). Every badge is
// derived from data a check-in already produces; nothing here asks a visitor
// for anything new. Computed fresh from checkins/users on every render (see
// the useMemo in App()) rather than stored, so tuning a threshold below is a
// code change, not a data migration.
// ---------------------------------------------------------------------------

const SEASON_BY_MONTH = {
  1: 'winter', 2: 'winter', 12: 'winter',
  3: 'spring', 4: 'spring', 5: 'spring',
  6: 'summer', 7: 'summer', 8: 'summer',
  9: 'fall', 10: 'fall', 11: 'fall',
};

const COMEBACK_GAP_DAYS = 60;
const FOUNDING_HERO_COUNT = 25;
const EARLY_LATE_THRESHOLD = 5;
const EARLY_LATE_WINDOW_MINUTES = 30;
// A month at the very edge of the data's date range is often only
// partially represented (data starts mid-month) — require at least this
// many scheduled days before a month counts toward "perfect", so a visitor
// can't earn it just by attending the one scheduled day the data happens
// to include.
const MIN_SCHEDULED_DAYS_FOR_PERFECT_MONTH = 3;

// Grouped the way the brainstorm framed them — milestones (raw volume),
// consistency (retention), time-of-day (an operational echo of the Patterns
// tab), variety (breadth of engagement) — so the tab reads as a small
// narrative instead of a flat list.
const ACHIEVEMENT_GROUPS = ['Milestones', 'Consistency', 'Time of Day', 'Variety'];

const ACHIEVEMENT_DEFINITIONS = [
  { id: 'checkin_10', group: 'Milestones', emoji: '🥉', name: 'First 10', description: '10 lifetime check-ins.' },
  { id: 'checkin_50', group: 'Milestones', emoji: '🥈', name: 'Fifty Strong', description: '50 lifetime check-ins.' },
  { id: 'checkin_100', group: 'Milestones', emoji: '🥇', name: 'Triple Digits', description: '100 lifetime check-ins.' },
  {
    id: 'founding_hero', group: 'Milestones', emoji: '🌱', name: 'Founding Hero',
    description: `One of the first ${FOUNDING_HERO_COUNT} users ever registered.`,
  },
  {
    id: 'regular', group: 'Consistency', emoji: '🔥', name: 'Regular',
    description: 'Attended 3 consecutive scheduled operating days.',
  },
  {
    id: 'perfect_month', group: 'Consistency', emoji: '🏆', name: 'Perfect Month',
    description: 'Attended every scheduled operating day in a calendar month.',
  },
  {
    id: 'comeback', group: 'Consistency', emoji: '🔄', name: 'Comeback',
    description: `Returned after a ${COMEBACK_GAP_DAYS}+ day gap since their previous visit.`,
  },
  {
    id: 'early_bird', group: 'Time of Day', emoji: '🌅', name: 'Early Bird',
    description: `${EARLY_LATE_THRESHOLD}+ check-ins within the first ${EARLY_LATE_WINDOW_MINUTES} minutes of a window.`,
  },
  {
    id: 'last_call', group: 'Time of Day', emoji: '🌇', name: 'Last Call',
    description: `${EARLY_LATE_THRESHOLD}+ check-ins within the final ${EARLY_LATE_WINDOW_MINUTES} minutes before close.`,
  },
  {
    id: 'weekday_completionist', group: 'Variety', emoji: '🗓️', name: 'Weekday Completionist',
    description: 'Checked in on Monday, Wednesday, and Saturday at least once.',
  },
  {
    id: 'every_season', group: 'Variety', emoji: '🍂', name: 'Every Season',
    description: 'Checked in during all four seasons, any year.',
  },
];

function parseDateKey(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return { y, m, d };
}

// Calendar-date weekday, independent of timezone — dateKey already IS the
// Eastern calendar day, so this just needs the component (not ISO-string)
// Date constructor to avoid a UTC-parsing off-by-one.
function dateKeyWeekday(dateKey) {
  const { y, m, d } = parseDateKey(dateKey);
  return new Date(y, m - 1, d).getDay();
}

function addDaysToDateKey(dateKey, days) {
  const { y, m, d } = parseDateKey(dateKey);
  const next = new Date(y, m - 1, d + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}

function daysBetweenDateKeys(a, b) {
  const { y: ay, m: am, d: ad } = parseDateKey(a);
  const { y: by, m: bm, d: bd } = parseDateKey(b);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / msPerDay);
}

// Every Mon/Wed/Sat calendar date between the earliest and latest regular
// check-in on record — the shared timeline "Regular"/"Perfect Month" measure
// attendance against, so they mean the same thing for every user rather than
// each being scored against their own personal window.
function scheduledOperatingDays(regularCheckins) {
  if (regularCheckins.length === 0) return [];
  const dateKeys = regularCheckins.map((c) => c.dateKey).sort();
  const first = dateKeys[0];
  const last = dateKeys[dateKeys.length - 1];
  const days = [];
  let cursor = first;
  while (cursor <= last) {
    if (CHECKIN_WINDOWS.some((w) => w.day === dateKeyWeekday(cursor))) days.push(cursor);
    cursor = addDaysToDateKey(cursor, 1);
  }
  return days;
}

function hasThreeConsecutiveScheduledDays(scheduleDays, attendedSet) {
  for (let i = 0; i + 2 < scheduleDays.length; i++) {
    if (
      attendedSet.has(scheduleDays[i]) &&
      attendedSet.has(scheduleDays[i + 1]) &&
      attendedSet.has(scheduleDays[i + 2])
    ) {
      return true;
    }
  }
  return false;
}

function hasPerfectMonth(scheduleDays, attendedSet) {
  const byMonth = {};
  scheduleDays.forEach((dateKey) => {
    const monthKey = dateKey.slice(0, 7);
    (byMonth[monthKey] = byMonth[monthKey] || []).push(dateKey);
  });
  return Object.values(byMonth).some(
    (days) => days.length >= MIN_SCHEDULED_DAYS_FOR_PERFECT_MONTH && days.every((d) => attendedSet.has(d))
  );
}

function hasComebackGap(sortedDateKeys) {
  for (let i = 1; i < sortedDateKeys.length; i++) {
    if (daysBetweenDateKeys(sortedDateKeys[i - 1], sortedDateKeys[i]) >= COMEBACK_GAP_DAYS) return true;
  }
  return false;
}

// Denominator is "active" users (at least one lifetime check-in) rather than
// every registered user — someone who signed up and never came back isn't a
// meaningful base rate for retention badges, and it keeps one consistent
// denominator across every row in the table.
function computeAchievements(users, checkins) {
  const regularCheckins = checkins.filter((c) => !c.eventId);
  const scheduleDays = scheduledOperatingDays(regularCheckins);
  const foundingUsernames = new Set(users.slice(0, FOUNDING_HERO_COUNT).map((u) => u.username.toLowerCase()));

  const checkinsByUsername = new Map();
  regularCheckins.forEach((c) => {
    const key = c.username.toLowerCase();
    if (!checkinsByUsername.has(key)) checkinsByUsername.set(key, []);
    checkinsByUsername.get(key).push(c);
  });

  const activeUsers = users.filter((u) => (u.totalCheckins || 0) > 0);
  const earnedCounts = {};
  ACHIEVEMENT_DEFINITIONS.forEach((def) => { earnedCounts[def.id] = 0; });

  activeUsers.forEach((user) => {
    const own = checkinsByUsername.get(user.username.toLowerCase()) || [];
    const sortedDateKeys = [...new Set(own.map((c) => c.dateKey))].sort();
    const attendedSet = new Set(sortedDateKeys);
    const earned = new Set();

    if ((user.totalCheckins || 0) >= 10) earned.add('checkin_10');
    if ((user.totalCheckins || 0) >= 50) earned.add('checkin_50');
    if ((user.totalCheckins || 0) >= 100) earned.add('checkin_100');
    if (foundingUsernames.has(user.username.toLowerCase())) earned.add('founding_hero');
    if (hasThreeConsecutiveScheduledDays(scheduleDays, attendedSet)) earned.add('regular');
    if (hasPerfectMonth(scheduleDays, attendedSet)) earned.add('perfect_month');
    if (hasComebackGap(sortedDateKeys)) earned.add('comeback');

    const weekdaysAttended = new Set(sortedDateKeys.map(dateKeyWeekday));
    if (weekdaysAttended.has(1) && weekdaysAttended.has(3) && weekdaysAttended.has(6)) {
      earned.add('weekday_completionist');
    }

    const seasonsAttended = new Set(sortedDateKeys.map((dk) => SEASON_BY_MONTH[parseDateKey(dk).m]));
    if (seasonsAttended.size === 4) earned.add('every_season');

    let earlyCount = 0;
    let lateCount = 0;
    own.forEach((c) => {
      const parts = getEasternParts(new Date(c.timestamp));
      const window = CHECKIN_WINDOWS.find((w) => w.day === parts.day);
      if (!window) return;
      const startMin = window.startHour * 60;
      const endMin = window.endHour * 60;
      if (parts.minutesSinceMidnight < startMin + EARLY_LATE_WINDOW_MINUTES) earlyCount += 1;
      if (parts.minutesSinceMidnight >= endMin - EARLY_LATE_WINDOW_MINUTES) lateCount += 1;
    });
    if (earlyCount >= EARLY_LATE_THRESHOLD) earned.add('early_bird');
    if (lateCount >= EARLY_LATE_THRESHOLD) earned.add('last_call');

    earned.forEach((id) => { earnedCounts[id] += 1; });
  });

  const activeCount = activeUsers.length;
  return {
    activeCount,
    badges: ACHIEVEMENT_DEFINITIONS.map((def) => ({
      ...def,
      earnedCount: earnedCounts[def.id],
      pct: activeCount > 0 ? Math.round((earnedCounts[def.id] / activeCount) * 100) : 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// Export logic
// ---------------------------------------------------------------------------

// Guards against CSV/formula injection: a cell that opens with =, +, -, @
// (or a tab/CR) is read as a formula by Excel/Sheets, not literal text.
// Nothing exported here is ever meant to be a formula — none of these
// fields are restricted enough at the source (email in particular allows
// almost any leading character) to rule it out, so every export goes
// through this. A leading apostrophe forces "text" in every major
// spreadsheet app without changing the underlying value.
const CSV_FORMULA_TRIGGER_CHARS = /^[=+\-@\t\r]/;

function escapeCsvField(value) {
  let text = String(value ?? '');
  if (CSV_FORMULA_TRIGGER_CHARS.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportCheckinsAsCSV(checkins) {
  const headers = ['username', 'dateKey', 'timestamp', 'eventId'];
  const lines = [
    headers.join(','),
    ...checkins.map((c) => headers.map((h) => escapeCsvField(c[h])).join(',')),
  ];
  const csv = lines.join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'recycle-heroes-checkins.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Database panel — Users tab: a searchable/filterable, column-configurable
// view, for building a one-off dataset to hand to a specific partner or
// funder (e.g. "48201 residents interested in curbside, no contact info").
// One column list drives the picker checkboxes, the table itself, and the
// CSV export, so there's exactly one place that knows what a "column" is.
// There's deliberately no separate "export everything" button anymore —
// checking on every column with no filters applied does the same thing.
// ---------------------------------------------------------------------------

const EXPLORER_COLUMNS = [
  { key: 'username', label: 'Username', value: (u) => u.username, default: true },
  { key: 'zip', label: 'ZIP', value: (u) => u.zip, default: true },
  { key: 'curbsideInterest', label: 'Wants Curbside', value: (u) => Boolean(u.curbsideInterest), format: (v) => (v ? 'Yes' : 'No'), default: true },
  { key: 'totalCheckins', label: 'Total Check-ins', value: (u) => u.totalCheckins ?? 0, default: true },
  { key: 'lastCheckinDate', label: 'Last Check-in', value: (u) => u.lastCheckinDate || '', default: true },
  { key: 'email', label: 'Email', value: (u) => u.email, default: false },
  { key: 'phone', label: 'Phone', value: (u) => u.phone, default: false },
  { key: 'noCurbsideAccess', label: 'No Curbside Access', value: (u) => Boolean(u.noCurbsideAccess), format: (v) => (v ? 'Yes' : 'No'), default: false },
  { key: 'buildingName', label: 'Building', value: (u) => u.buildingName || '', default: false },
  { key: 'optedIn', label: 'Opted In to Updates', value: (u) => Boolean(u.smsOptIn), format: (v) => (v ? 'Yes' : 'No'), default: false },
  { key: 'registeredDate', label: 'Registered', value: (u) => u.registeredDate || '', default: false },
  { key: 'firstCheckinDate', label: 'First Check-in', value: (u) => u.firstCheckinDate || '', default: false },
  { key: 'eventsAttended', label: 'Events Attended', value: (u) => (u.eventsAttended || []).length, default: false },
];

const EMPTY_EXPLORER_FILTERS = {
  search: '',
  zip: '',
  curbsideInterest: 'any', // 'any' | 'yes' | 'no'
  noCurbsideAccess: 'any',
  optedIn: 'any',
  minCheckins: '',
  registeredFrom: '',
  registeredTo: '',
};

function filterExplorerUsers(users, filters) {
  const query = filters.search.trim().toLowerCase();
  const queryDigits = query.replace(/\D/g, '');
  const zip = filters.zip.trim();
  const minCheckins = filters.minCheckins.trim() === '' ? null : Number(filters.minCheckins);

  return users.filter((u) => {
    // Phone matching (digit-normalized, same minimum-length guard as the
    // old standalone username-recovery tool this search absorbed) lives
    // alongside the plain substring checks so one search box covers both
    // "find people in this ZIP" and "someone forgot their username, here's
    // their phone number."
    const phoneMatch =
      queryDigits.length >= CONTACT_LOOKUP_MIN_PHONE_DIGITS &&
      Boolean(u.phone) &&
      u.phone.replace(/\D/g, '').includes(queryDigits);
    if (
      query &&
      !phoneMatch &&
      !u.username.toLowerCase().includes(query) &&
      !(u.email || '').toLowerCase().includes(query) &&
      !(u.zip || '').toLowerCase().includes(query) &&
      !(u.buildingName || '').toLowerCase().includes(query)
    ) {
      return false;
    }
    if (zip && u.zip !== zip) return false;
    if (filters.curbsideInterest !== 'any' && Boolean(u.curbsideInterest) !== (filters.curbsideInterest === 'yes')) return false;
    if (filters.noCurbsideAccess !== 'any' && Boolean(u.noCurbsideAccess) !== (filters.noCurbsideAccess === 'yes')) return false;
    if (filters.optedIn !== 'any' && Boolean(u.smsOptIn) !== (filters.optedIn === 'yes')) return false;
    if (minCheckins !== null && !Number.isNaN(minCheckins) && (u.totalCheckins ?? 0) < minCheckins) return false;
    // registeredDate is a "YYYY-MM-DD" dateKey — plain string comparison
    // sorts chronologically without needing to parse it into a Date.
    if (filters.registeredFrom && (!u.registeredDate || u.registeredDate < filters.registeredFrom)) return false;
    if (filters.registeredTo && (!u.registeredDate || u.registeredDate > filters.registeredTo)) return false;
    return true;
  });
}

function sortExplorerUsers(rows, sortField, sortDir) {
  const column = EXPLORER_COLUMNS.find((c) => c.key === sortField) || EXPLORER_COLUMNS[0];
  const sorted = [...rows].sort((a, b) => {
    const av = column.value(a);
    const bv = column.value(b);
    if (typeof av === 'number' && typeof bv === 'number') return av - bv;
    if (typeof av === 'boolean' && typeof bv === 'boolean') return (av === bv ? 0 : av ? -1 : 1);
    return String(av ?? '').localeCompare(String(bv ?? ''));
  });
  return sortDir === 'desc' ? sorted.reverse() : sorted;
}

function triggerCsvDownload(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Exports exactly what's on screen would show if nothing were capped — the
// filtered+sorted row set and only the columns currently checked on in the
// picker. That's the whole point of this tool: a curated slice meant to
// hand to one specific partner or funder, not a fixed all-columns dump.
function exportExplorerDatasetAsCSV(rows, visibleColumnKeys) {
  const columns = EXPLORER_COLUMNS.filter((c) => visibleColumnKeys.includes(c.key));
  const lines = [
    columns.map((c) => escapeCsvField(c.label)).join(','),
    ...rows.map((u) =>
      columns.map((c) => escapeCsvField(c.format ? c.format(c.value(u)) : c.value(u))).join(',')
    ),
  ];
  triggerCsvDownload(`recycle-heroes-custom-dataset-${getEasternNow().dateKey}.csv`, lines.join('\r\n'));
}

// Full localStorage snapshot — separate from the users-only CSV, meant for
// moving/backing up all app state (users, checkins, events, theme, MOTD)
// as one file, e.g. between devices with no shared backend. Shared by the
// manual "Export JSON" button and the automatic backup system below, so
// there's exactly one definition of "everything."
function buildFullStateSnapshot() {
  return {
    users: loadUsers(),
    checkins: loadCheckins(),
    theme: loadTheme(),
    motd: loadMotd(),
    events: loadEvents(),
    visitors: loadVisitors(),
    weights: loadWeights(),
  };
}

function exportFullState() {
  const state = buildFullStateSnapshot();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'recycleHeroes_full_state.json';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Automatic backup (layered — see the conversation this came from):
//   1. Silent daily backup via the File System Access API (Chrome/Edge only,
//      requires a one-time folder pick to grant write permission).
//   2. A reminder that fires whenever a backup — silent OR manual — hasn't
//      landed in the last 24 hours, regardless of *why* the silent path
//      didn't run (unsupported browser, revoked permission, anything else).
// The reminder is the safety net: "automatic" only ever means "automatic
// when it can be," never a substitute for admin visibility into whether
// it's actually working.
// ---------------------------------------------------------------------------

const LAST_BACKUP_STORAGE_KEY = 'recycleHeroesLastBackup';
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BACKUP_RETENTION_COUNT = 14; // keep the last 14 daily snapshots, prune older
const BACKUP_FILENAME_PREFIX = 'recycleHeroes_backup_';

function loadLastBackupTimestamp() {
  try {
    const raw = localStorage.getItem(LAST_BACKUP_STORAGE_KEY);
    return raw ? new Date(raw) : null;
  } catch {
    return null;
  }
}

function saveLastBackupTimestamp(date) {
  safeSetItem(LAST_BACKUP_STORAGE_KEY, date.toISOString());
}

// The directory handle isn't a string, so it can't live in localStorage —
// IndexedDB is the only browser storage that can hold a structured-clone-
// able handle across sessions. One object store, one fixed key; this is the
// only thing this DB is for.
const BACKUP_DB_NAME = 'recycleHeroesBackupDB';
const BACKUP_DB_STORE = 'handles';
const BACKUP_DIR_HANDLE_KEY = 'backupDirectoryHandle';

function openBackupDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BACKUP_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(BACKUP_DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveBackupDirectoryHandle(handle) {
  const db = await openBackupDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BACKUP_DB_STORE, 'readwrite');
    tx.objectStore(BACKUP_DB_STORE).put(handle, BACKUP_DIR_HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadBackupDirectoryHandle() {
  const db = await openBackupDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BACKUP_DB_STORE, 'readonly');
    const req = tx.objectStore(BACKUP_DB_STORE).get(BACKUP_DIR_HANDLE_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function clearBackupDirectoryHandle() {
  const db = await openBackupDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BACKUP_DB_STORE, 'readwrite');
    tx.objectStore(BACKUP_DB_STORE).delete(BACKUP_DIR_HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function backupFilenameForDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const dateKey = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${BACKUP_FILENAME_PREFIX}${dateKey}.json`;
}

// Deletes backups beyond the retention count, oldest first. Dated filenames
// sort chronologically as plain strings, so no date parsing needed. Best-
// effort — a failed delete just leaves an extra old file, not a real problem.
async function pruneOldBackups(dirHandle) {
  const names = [];
  for await (const [name, entry] of dirHandle.entries()) {
    if (entry.kind === 'file' && name.startsWith(BACKUP_FILENAME_PREFIX) && name.endsWith('.json')) {
      names.push(name);
    }
  }
  names.sort();
  const excess = names.length - BACKUP_RETENTION_COUNT;
  for (const name of names.slice(0, Math.max(0, excess))) {
    try {
      await dirHandle.removeEntry(name);
    } catch {
      // Non-fatal.
    }
  }
}

// Attempts one silent backup write. Returns true only on a real, confirmed
// write — every failure path (unsupported browser, no folder configured,
// permission not currently granted, or any thrown error) returns false so
// the reminder keeps doing its job. queryPermission is used rather than
// requestPermission deliberately: it doesn't require a user gesture, so
// this is safe to call from a background timer — requestPermission (which
// DOES need a click) only ever happens in handleSetupBackup, never here.
async function writeSilentBackup() {
  if (!('showDirectoryPicker' in window)) return false;

  let handle;
  try {
    handle = await loadBackupDirectoryHandle();
  } catch {
    return false;
  }
  if (!handle) return false;

  try {
    const permission = await handle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') return false;

    const fileHandle = await handle.getFileHandle(backupFilenameForDate(new Date()), { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(buildFullStateSnapshot(), null, 2));
    await writable.close();

    await pruneOldBackups(handle);
    return true;
  } catch {
    return false;
  }
}

function formatBackupTimestamp(date) {
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Reads `file`, and on success overwrites every localStorage key with its
// contents. Calls `onDone(errorMessageOrNull)` — a full reload is the
// simplest correct way to get every piece of React state back in sync
// with the newly-written storage, so the caller is expected to reload.
//
// Runs the same runIntegrityCheck used for the read-only admin audit
// against the parsed file *before* writing anything — unlike that audit
// (which only ever reports on data already live), a bad import is still
// avoidable, so this uses the identical rule set to refuse the write
// instead of just flagging it after the fact.
function importStateFromFile(file, onDone) {
  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      const state = JSON.parse(evt.target.result);
      const users = Array.isArray(state.users) ? state.users : [];
      const checkins = Array.isArray(state.checkins) ? state.checkins : [];
      const visitors = Array.isArray(state.visitors) ? state.visitors : [];
      const events = Array.isArray(state.events) ? state.events : [];
      const weights = Array.isArray(state.weights) ? state.weights : [];

      const warnings = runIntegrityCheck(users, checkins, visitors, events, weights);
      if (warnings.length > 0) {
        const preview = warnings.slice(0, 3).join(' ');
        onDone(
          `Import blocked: ${warnings.length} data issue${warnings.length === 1 ? '' : 's'} found in that file. ${preview}${warnings.length > 3 ? ' …' : ''}`
        );
        return;
      }

      // localStorage has no transactions — if the browser's storage quota
      // is hit partway through, some keys below may have already written
      // successfully while later ones fail. Nothing to roll back to, but
      // this at least tells the admin to check rather than assuming the
      // "success" reload reflects a fully-consistent import.
      const allSaved = [
        saveUsers(users),
        saveCheckins(checkins),
        safeSetItem(THEME_STORAGE_KEY, state.theme === 'light' ? 'light' : 'dark'),
        saveMotd(typeof state.motd === 'string' ? state.motd : ''),
        saveEvents(events),
        saveVisitors(visitors),
        saveWeights(weights),
      ].every(Boolean);

      if (!allSaved) {
        onDone('Import partially failed — your browser storage may be full. Check Data Management before continuing; some data may be inconsistent.');
        return;
      }
      onDone(null);
    } catch {
      onDone('Invalid JSON file.');
    }
  };
  reader.onerror = () => onDone('Could not read that file.');
  reader.readAsText(file);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

// Bump manually alongside package.json's "version" — no build-time version
// injection is wired up (keeping the dependency list unchanged).
const APP_VERSION = '0.2.0';

// Mirrors WriteWindowSeconds in rfid-bridge/Program.cs — the bridge is the
// actual enforcement point, this is only used to drive the on-screen
// countdown so it doesn't just show a frozen "armed" message.
const WRITE_WINDOW_SECONDS = 25;

// Backstop for card writes/wipes: the bridge is supposed to always resolve
// an armed write with a result or an expiry message, but a card pulled
// away mid-operation was found to throw an exception the bridge didn't
// catch, which skipped that broadcast entirely and left the UI stuck on
// "armed" forever with no way out (this flow has no cancel button by
// design). The bridge now catches that case too, but this client-side
// ceiling exists so a stuck state can never happen again regardless of
// what future bridge-side bug might cause the same kind of silence.
const CARD_SAFETY_NET_MS = (WRITE_WINDOW_SECONDS + 10) * 1000;

const EMPTY_FORM = {
  username: '',
  email: '',
  phone: '',
  zip: '',
  curbsideInterest: false,
  noCurbsideAccess: false,
  buildingName: '',
  smsOptIn: false,
  emailOptIn: false,
};

const EMPTY_EVENT_FORM = {
  name: '',
  startTime: '',
  endTime: '',
  notes: '',
};

export default function App() {
  const [theme, setTheme] = useState(loadTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    safeSetItem(THEME_STORAGE_KEY, theme); // not fatal if this fails — theme just won't persist across reloads
  }, [theme]);

  function toggleTheme() {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }

  const [users, setUsers] = useState(loadUsers);
  const [checkins, setCheckins] = useState(loadCheckins);

  const [adminOpen, setAdminOpen] = useState(false);
  const [adminMessage, setAdminMessage] = useState('');
  // Admin Tools started as several independently-toggled corner popovers
  // (event creation, data management, check-in log), got consolidated into
  // one tabbed panel to avoid hand-written mutual exclusion, then had
  // Data/Check-ins pulled back out again into the Database panel below once
  // those grew large enough to want their own room — so this is back to a
  // single-purpose panel (event scheduling) with no tab strip of its own.
  const [adminToolsOpen, setAdminToolsOpen] = useState(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [analyticsTab, setAnalyticsTab] = useState('heatmap');
  // The Database panel gets its own wide, centered panel rather than a tab
  // inside Admin Tools' narrow corner popover — same reasoning as Analytics
  // below: a real data table needs more room than 360px to read cleanly.
  const [explorerOpen, setExplorerOpen] = useState(false);
  // Crash-test aid: a floating live-data view (so counts are visible without
  // switching Admin Tools tabs mid-test) plus one switch that waves through
  // both real check-in gates — business hours and the once-per-day/event
  // limit — so repeated registration/activation/check-in passes aren't
  // blocked by the very rules a normal visitor would be subject to. Purely
  // a debug aid, same spirit as eventModeOverride below; not meant to ship
  // toggled on.
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugBypassGates, setDebugBypassGates] = useState(false);

  // Admin Panel/Admin Tools/Debug (all bottom-right corner) and Analytics/
  // Database (both centered) can each be open at the same time as their
  // same-corner sibling, and since they fully overlap, whichever rendered
  // later in the JSX always painted on top — so a covered panel (e.g.
  // Database open on top of Analytics, or the Admin Panel drawer pinned
  // above everything it spawns) was completely unreachable, fab click
  // included, because closed-vs-open was the only thing the fab
  // controlled. This gives every floating panel — including the Admin
  // Panel drawer itself — its own z-index, bumped to the front whenever
  // its fab/toggle is clicked; clicking the control for whichever panel is
  // *already* frontmost closes it (same gesture as before), but clicking
  // one that's open-but-covered now raises it instead of closing it — same
  // as clicking a background window's taskbar icon. The ⚙ toggle button
  // itself sits just outside the drawer's own footprint (see .admin-toggle
  // in App.css) so it's never the thing that ends up buried.
  const panelZCounterRef = useRef(30);
  const [panelZIndex, setPanelZIndex] = useState({
    adminPanel: 30,
    adminTools: 30,
    analytics: 30,
    debug: 30,
    explorer: 30,
  });

  function toggleFloatingPanel(isOpen, setIsOpen, key) {
    const isFrontmost = panelZIndex[key] === panelZCounterRef.current;
    if (isOpen && isFrontmost) {
      setIsOpen(false);
      return;
    }
    if (!isOpen) setIsOpen(true);
    panelZCounterRef.current += 1;
    setPanelZIndex((prev) => ({ ...prev, [key]: panelZCounterRef.current }));
  }

  const [checkinSearch, setCheckinSearch] = useState('');
  // Database panel — the single home for Users (search/filter/export),
  // Check-ins, Weight Log, and Backup & Restore, consolidated out of the
  // old separate "Data"/"Check-ins" Admin Tools tabs and the standalone
  // username-recovery widget once they'd become redundant with this panel.
  // See EXPLORER_COLUMNS/filterExplorerUsers above.
  const [explorerPanelTab, setExplorerPanelTab] = useState('users');
  const [explorerFilters, setExplorerFilters] = useState(EMPTY_EXPLORER_FILTERS);
  const [explorerVisibleColumns, setExplorerVisibleColumns] = useState(() =>
    Object.fromEntries(EXPLORER_COLUMNS.map((c) => [c.key, c.default]))
  );
  const [explorerSortField, setExplorerSortField] = useState('username');
  const [explorerSortDir, setExplorerSortDir] = useState('asc');
  // Manual on/off switch, independent of any real event's start/end window —
  // debugging aid for now, not wired into check-in tagging or anything else.
  const [eventModeOverride, setEventModeOverride] = useState(false);

  const [motd, setMotd] = useState(loadMotd);
  const [motdDraft, setMotdDraft] = useState(loadMotd);

  const [events, setEvents] = useState(loadEvents);
  const [eventForm, setEventForm] = useState(EMPTY_EVENT_FORM);

  // Separate from `users` entirely — see the Visitors data-model comment up top.
  const [visitors, setVisitors] = useState(loadVisitors);

  const [weights, setWeights] = useState(loadWeights);
  const [weightDraft, setWeightDraft] = useState('');
  const [weightPendingConfirm, setWeightPendingConfirm] = useState(false);
  const [weightLogOpen, setWeightLogOpen] = useState(false);

  // Was a one-time useState() computed only at mount (visitors/events/
  // weights weren't declared yet at that point in the component, so it had
  // to read straight from storage) — meant it silently went stale the
  // moment any of those changed during the session, which is most of why
  // it read as "a mostly useless data point." Now a live useMemo, and
  // lives as a real feature (view + Auto-Fix) in the Database panel's
  // Backup & Restore tab rather than a static count in the Admin Panel
  // drawer — still worth keeping since malformed data can still arrive via
  // JSON import, just not worth a permanent stat for data that's
  // validated at the point of entry everywhere else now.
  const integrityWarnings = useMemo(
    () => runIntegrityCheck(users, checkins, visitors, events, weights),
    [users, checkins, visitors, events, weights]
  );
  const [warningsOpen, setWarningsOpen] = useState(false);
  const [editingWeightId, setEditingWeightId] = useState(null);
  const [editWeightDraft, setEditWeightDraft] = useState('');

  // One-time migration: entries logged before per-entry ids existed get one
  // assigned now, so edit/delete (which target entries by id) can reach them.
  useEffect(() => {
    if (weights.some((w) => !w.id)) {
      const migrated = weights.map((w, i) => (w.id ? w : { ...w, id: `weight_${String(i + 1).padStart(4, '0')}` }));
      saveWeights(migrated);
      setWeights(migrated);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ticks every 30s (same cadence as the check-in window re-check below) so
  // event mode starts/ends on its own as real time crosses an event's
  // start/end — not just when `events` itself changes.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(interval);
  }, []);

  // Automatic backup — see buildFullStateSnapshot/writeSilentBackup above.
  const [backupSupported] = useState(() => typeof window !== 'undefined' && 'showDirectoryPicker' in window);
  const [backupFolderName, setBackupFolderName] = useState(null);
  const [lastBackupAt, setLastBackupAt] = useState(() => loadLastBackupTimestamp());
  const [backupMessage, setBackupMessage] = useState('');

  // On mount, pick up a folder handle from a previous session (if any) and
  // confirm permission is still actually granted — queryPermission needs no
  // gesture, so this is safe to run unattended.
  useEffect(() => {
    if (!backupSupported) return;
    let cancelled = false;
    loadBackupDirectoryHandle()
      .then(async (handle) => {
        if (cancelled || !handle) return;
        const permission = await handle.queryPermission({ mode: 'readwrite' }).catch(() => 'denied');
        if (!cancelled && permission === 'granted') setBackupFolderName(handle.name);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [backupSupported]);

  // Checked once on mount and then every 15 minutes — a kiosk tab can stay
  // open for days, so this can't only fire on page load. Each tick is a
  // cheap timestamp comparison; the actual write only happens once it's
  // genuinely been 24+ hours since the last one.
  useEffect(() => {
    async function maybeRunBackup() {
      const last = loadLastBackupTimestamp();
      const due = !last || Date.now() - last.getTime() >= BACKUP_INTERVAL_MS;
      if (!due) return;
      const success = await writeSilentBackup();
      if (success) {
        const at = new Date();
        saveLastBackupTimestamp(at);
        setLastBackupAt(at);
      }
    }
    maybeRunBackup();
    const interval = setInterval(maybeRunBackup, 15 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Nothing worth alarming an admin about on a fresh install with zero
  // data yet — the reminder only engages once there's something real to lose.
  const backupStale =
    (users.length > 0 || checkins.length > 0) &&
    (!lastBackupAt || now.getTime() - lastBackupAt.getTime() >= BACKUP_INTERVAL_MS);

  // Shared by both the dedicated backup button and the pre-existing
  // "Export JSON" button — any full-state export is a real backup, so both
  // reset the same clock rather than running two disconnected systems.
  function handleManualBackup() {
    exportFullState();
    const at = new Date();
    saveLastBackupTimestamp(at);
    setLastBackupAt(at);
    setBackupMessage('Backup downloaded.');
  }

  async function handleSetupBackup() {
    if (!backupSupported) return;
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await saveBackupDirectoryHandle(handle);
      setBackupFolderName(handle.name);
      setBackupMessage('Backup folder set — running first backup…');
      const success = await writeSilentBackup();
      if (success) {
        const at = new Date();
        saveLastBackupTimestamp(at);
        setLastBackupAt(at);
        setBackupMessage('Backup folder set — first backup saved.');
      } else {
        setBackupMessage('Backup folder set, but the first backup failed — try Backup Now below.');
      }
    } catch (err) {
      // AbortError just means the admin closed the folder picker — not a
      // real failure, nothing to report.
      if (err && err.name !== 'AbortError') {
        setBackupMessage('Could not set up automatic backup.');
      }
    }
  }

  async function handleDisconnectBackup() {
    await clearBackupDirectoryHandle().catch(() => {});
    setBackupFolderName(null);
    setBackupMessage('Automatic backup turned off.');
  }

  // Prefer the most recently created event among any that are currently
  // active, in case two windows ever overlap.
  const currentEvent = [...events].reverse().find((ev) => isEventActive(ev, now)) || null;

  // "Event mode" is active whenever there's a real current event OR the
  // debug override is on — the override exists specifically so this whole
  // behavior can be exercised without waiting on/creating a real event.
  // With no real event backing the override, checkins/eventsAttended still
  // need *some* id to dedupe against, hence the synthetic fallback.
  const inEventMode = Boolean(currentEvent) || eventModeOverride;
  const activeEventId = currentEvent ? currentEvent.id : eventModeOverride ? 'debug-event-mode' : null;

  // Event mode is dark-only. Entering it while in light mode forces dark
  // and remembers the prior preference; leaving it restores that preference
  // (the theme-toggle button itself is also disabled below, but this covers
  // entry via a real event's start time, not just the manual toggle).
  const [preEventTheme, setPreEventTheme] = useState(null);
  useEffect(() => {
    if (inEventMode) {
      if (theme !== 'dark') {
        setPreEventTheme(theme);
        setTheme('dark');
      }
    } else if (preEventTheme) {
      setTheme(preEventTheme);
      setPreEventTheme(null);
    }
    // Intentionally only re-runs on inEventMode transitions, not on every
    // theme change — see the dedicated theme-toggle disabling below for why
    // manual changes can't happen while this is active anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inEventMode]);

  // A separate attribute (rather than overloading data-theme) so CSS can
  // layer the neon event-mode palette on top of dark mode specifically.
  useEffect(() => {
    document.documentElement.setAttribute('data-event-mode', inEventMode ? 'true' : 'false');
  }, [inEventMode]);

  // Admin panel event-mode stats — folds together both check-in sources
  // (visitors, and existing users who checked in during event mode via the
  // normal username flow) so this reflects true event attendance rather
  // than undercounting whenever a registered user shows up to an event.
  const mostPreviousEvent = getMostPreviousEvent(events, currentEvent ? currentEvent.id : null, now);
  const eventCheckinsCurrent =
    countVisitorCheckinsForEvent(visitors, activeEventId) + countUserCheckinsForEvent(checkins, activeEventId);
  const eventCheckinsPrevious = mostPreviousEvent
    ? countVisitorCheckinsForEvent(visitors, mostPreviousEvent.id) + countUserCheckinsForEvent(checkins, mostPreviousEvent.id)
    : 0;
  const eventCheckinsAllTime = totalVisitorCheckins(visitors) + totalUserEventCheckins(checkins);

  // These scale with users × checkins (some literally, like the ZIP
  // aggregation; some just with checkins, like the pattern analysis) and
  // App() re-renders on every keystroke anywhere in the app, every 30s
  // `now` tick, etc. — without memoization, all of them were re-running on
  // every one of those, which is what turned "type a character" into a
  // multi-second stall once there was realistic data volume. Memoized on
  // their actual inputs so they only redo the work when those change.
  const topZipsUsers = useMemo(() => topZipsByRegisteredUsers(users, 5), [users]);
  const topZipsActivity = useMemo(() => topZipsByActivity(users, checkins, 5), [users, checkins]);
  const topUsersCheckins = useMemo(() => topUsersByCheckins(users, 3), [users]);
  const lowestParticipationZips = useMemo(
    () => zipParticipationTrends(users, checkins, now, 30, 5),
    [users, checkins, now]
  );
  const checkinPatterns = useMemo(() => sessionCheckinPatterns(checkins), [checkins]);
  const achievements = useMemo(() => computeAchievements(users, checkins), [users, checkins]);

  // Check-in log browser (Data Management → Check-in Log panel) — filtered
  // by username, newest first, capped for render performance since this
  // log can grow into the thousands over time (unlike the other lists).
  const checkinSearchQuery = checkinSearch.trim().toLowerCase();
  const matchingCheckins = useMemo(
    () =>
      checkinSearchQuery
        ? checkins.filter((c) => c.username.toLowerCase().includes(checkinSearchQuery))
        : checkins,
    [checkins, checkinSearchQuery]
  );
  const shownCheckins = useMemo(
    () => [...matchingCheckins].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 50),
    [matchingCheckins]
  );

  // Database panel, Users tab — matchingExplorerUsers is the full
  // filtered+sorted set (what the CSV export actually uses);
  // shownExplorerUsers caps what actually renders, same "count everything,
  // render a page of it" split as the check-in log above.
  const matchingExplorerUsers = useMemo(
    () => sortExplorerUsers(filterExplorerUsers(users, explorerFilters), explorerSortField, explorerSortDir),
    [users, explorerFilters, explorerSortField, explorerSortDir]
  );
  const shownExplorerUsers = useMemo(() => matchingExplorerUsers.slice(0, 100), [matchingExplorerUsers]);
  const explorerVisibleColumnDefs = useMemo(
    () => EXPLORER_COLUMNS.filter((c) => explorerVisibleColumns[c.key]),
    [explorerVisibleColumns]
  );
  const explorerVisibleColumnKeys = useMemo(
    () => explorerVisibleColumnDefs.map((c) => c.key),
    [explorerVisibleColumnDefs]
  );

  function handleExplorerFilterChange(field, value) {
    setExplorerFilters((prev) => ({ ...prev, [field]: value }));
  }

  function handleExplorerColumnToggle(key) {
    setExplorerVisibleColumns((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function handleExplorerSortClick(key) {
    if (explorerSortField === key) {
      setExplorerSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setExplorerSortField(key);
      setExplorerSortDir('asc');
    }
  }

  const importFileInputRef = useRef(null);
  const [importPendingConfirm, setImportPendingConfirm] = useState(false);

  // A quick Esc tap closes just the topmost open pop-out, one layer per
  // press. Admin Tools (bottom-right) and Analytics (centered) occupy
  // different screen zones and can be open together, so either can be
  // "topmost" — checking both before falling back to the admin drawer
  // itself, the outermost layer.
  //
  // Holding Esc for 2s instead closes everything in one go — a panic/reset
  // gesture for when several panels have piled up. Tap-vs-hold is decided
  // on keyup: a timer starts on keydown, and if it fires before release the
  // hold action runs and the later keyup's normal tap-close is skipped.
  const escHoldTimerRef = useRef(null);
  const escHoldFiredRef = useRef(false);

  useEffect(() => {
    function closeAll() {
      setAdminToolsOpen(false);
      setAnalyticsOpen(false);
      setExplorerOpen(false);
      setAdminOpen(false);
    }

    function handleKeyDown(evt) {
      if (evt.key !== 'Escape' || evt.repeat) return;
      escHoldFiredRef.current = false;
      escHoldTimerRef.current = setTimeout(() => {
        escHoldFiredRef.current = true;
        closeAll();
      }, 2000);
    }

    function handleKeyUp(evt) {
      if (evt.key !== 'Escape') return;
      if (escHoldTimerRef.current) {
        clearTimeout(escHoldTimerRef.current);
        escHoldTimerRef.current = null;
      }
      if (escHoldFiredRef.current) {
        escHoldFiredRef.current = false;
        return;
      }
      if (adminToolsOpen) {
        setAdminToolsOpen(false);
      } else if (analyticsOpen) {
        setAnalyticsOpen(false);
      } else if (explorerOpen) {
        setExplorerOpen(false);
      } else if (adminOpen) {
        setAdminOpen(false);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      if (escHoldTimerRef.current) clearTimeout(escHoldTimerRef.current);
    };
  }, [adminToolsOpen, analyticsOpen, explorerOpen, adminOpen]);

  const [checkinUsername, setCheckinUsername] = useState('');
  const [checkinMessage, setCheckinMessage] = useState('');
  // Same "shows, then gets out of the way" philosophy as the card cue below
  // — a successful check-in doesn't need a lingering banner. A ref (not an
  // effect keyed on the message text) so back-to-back successes each get
  // their own fresh 3s window instead of racing a stale timer.
  const checkinSuccessTimerRef = useRef(null);
  const [checkinOpen, setCheckinOpen] = useState(isCheckinOpen);

  const [form, setForm] = useState(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState({});
  const [registerMessage, setRegisterMessage] = useState('');
  // Collapsed by default — check-in is the primary flow; registration is
  // comparatively rare (once per attendee) and was crowding the screen.
  const [registrationOpen, setRegistrationOpen] = useState(false);

  // Re-check the check-in window periodically so the UI unlocks/locks on
  // its own without requiring a page reload right at the boundary.
  useEffect(() => {
    const interval = setInterval(() => setCheckinOpen(isCheckinOpen()), 30000);
    return () => clearInterval(interval);
  }, []);

  // usernameOverride lets a non-typing input source (the RFID bridge) drive
  // this exact same flow — hours gating, duplicate-checkin dedupe, event vs.
  // regular mode — rather than a second, easy-to-drift-out-of-sync copy of
  // this logic. `e` is optional since a card tap has no real DOM event.
  function handleCheckin(e, usernameOverride) {
    e?.preventDefault();
    const username = usernameOverride ?? checkinUsername;
    // Time gating doesn't apply in event mode — the event's own start/end
    // window already limits when this is possible. debugBypassGates skips
    // it too, for crash-testing outside business hours.
    if (!inEventMode && !debugBypassGates && !isCheckinOpen()) {
      setCheckinOpen(false);
      setCheckinMessage(`Check-in is closed right now. Hours: ${CHECKIN_HOURS_TEXT}.`);
      return;
    }
    if (!username.trim()) {
      setCheckinMessage('Enter a username to check in.');
      return;
    }
    const found = findUserByUsername(users, username);
    if (!found) {
      setCheckinMessage('User not found. Please register below.');
      setRegistrationOpen(true);
      return;
    }

    const { dateKey } = getEasternNow();

    // Event attendance is tracked separately from the regular once-a-day
    // check-in: someone who already checked in during business hours today
    // can still check into the event — the only dedupe that applies here is
    // "already attended this specific event," not "already checked in today."
    // debugBypassGates skips both dedupe checks, for repeated crash-test
    // taps of the same test user.
    if (!debugBypassGates && inEventMode) {
      const alreadyAttended = checkins.some(
        (c) => c.username.toLowerCase() === found.username.toLowerCase() && c.eventId === activeEventId
      );
      if (alreadyAttended) {
        setCheckinMessage("You've already checked in to this event.");
        return;
      }
    } else if (!debugBypassGates && !inEventMode && hasCheckedInToday(checkins, found.username, dateKey)) {
      setCheckinMessage("You've already checked in today.");
      return;
    }

    const eventId = inEventMode ? activeEventId : null;

    const updatedCheckins = [
      ...checkins,
      { username: found.username, dateKey, timestamp: new Date().toISOString(), eventId },
    ];
    saveCheckins(updatedCheckins);
    setCheckins(updatedCheckins);

    const updatedUsers = users.map((u) =>
      u.username.toLowerCase() === found.username.toLowerCase() ? applyCheckinToUser(u, dateKey, eventId) : u
    );
    saveUsers(updatedUsers);
    setUsers(updatedUsers);

    setCheckinMessage('Check-in successful');
    setCheckinUsername('');
    if (checkinSuccessTimerRef.current) clearTimeout(checkinSuccessTimerRef.current);
    checkinSuccessTimerRef.current = setTimeout(() => setCheckinMessage(''), 3000);
  }

  // Always-current reference to handleCheckin for the WebSocket effect
  // below. handleCheckin is a fresh closure every render (it reads
  // users/checkins/inEventMode directly), but the socket connection itself
  // should only be set up once — reconnecting on every render would thrash
  // it. Syncing a ref after every render is the standard way to give a
  // long-lived subscription access to current state without either problem.
  const handleCheckinRef = useRef(handleCheckin);
  useEffect(() => {
    handleCheckinRef.current = handleCheckin;
  });

  // Card-programming state, shared by both the post-registration prompt and
  // the standalone Cards admin tool — only one write can ever be in flight
  // at a time (the bridge only tracks one pending write), so one status
  // object covers whichever UI triggered it. `username` on the status lets
  // each UI decide whether the update is actually about the card IT armed.
  const [rfidBridgeConnected, setRfidBridgeConnected] = useState(false);
  const [cardWriteStatus, setCardWriteStatus] = useState(null); // { username, state: 'sending'|'armed'|'success'|'error'|'expired', error }
  const [postRegistrationUsername, setPostRegistrationUsername] = useState(null);
  // A brief heads-up, not a "wait for something to happen" indicator — it's
  // just there long enough for someone to read it before moving on, then
  // gets out of the way on its own regardless of whether a card ever gets
  // activated.
  const [cardReminderVisible, setCardReminderVisible] = useState(false);
  useEffect(() => {
    if (!postRegistrationUsername) {
      setCardReminderVisible(false);
      return;
    }
    setCardReminderVisible(true);
    const timer = setTimeout(() => setCardReminderVisible(false), 8000);
    return () => clearTimeout(timer);
  }, [postRegistrationUsername]);

  // The post-registration card flow is fully ambient: no buttons, nothing
  // to dismiss. It shows a visual cue while a write is in flight, briefly
  // holds on the outcome, fades it out, then resets registration back to
  // its default state entirely on its own. A technician has no reason to
  // skip this — if the automatic window is missed or the bridge isn't
  // connected, Card Management (below the form) is the manual fallback.
  const [cardCueFading, setCardCueFading] = useState(false);
  useEffect(() => {
    if (!postRegistrationUsername) {
      setCardCueFading(false);
      return;
    }
    const relevant =
      cardWriteStatus && cardWriteStatus.username === postRegistrationUsername ? cardWriteStatus.state : null;

    if (relevant === 'sending' || relevant === 'armed') return undefined; // the bridge will resolve this on its own

    // success holds briefly so the checkmark is actually seen; a failure or
    // a missed window holds a bit longer since there's a short notice to
    // read; "nothing ever armed" (no bridge) gets a fixed grace period since
    // nothing external is ever going to resolve it.
    const holdMs = relevant === 'success' ? 1600 : relevant === 'error' || relevant === 'expired' ? 3500 : 8000;
    const holdTimer = setTimeout(() => setCardCueFading(true), holdMs);
    return () => clearTimeout(holdTimer);
  }, [postRegistrationUsername, cardWriteStatus]);

  useEffect(() => {
    if (!cardCueFading) return;
    // Matches the CSS fade-out transition duration below.
    const fadeTimer = setTimeout(() => {
      setPostRegistrationUsername(null);
      setCardWriteStatus(null);
      setCardCueFading(false);
    }, 500);
    return () => clearTimeout(fadeTimer);
  }, [cardCueFading]);

  const [cardManagementOpen, setCardManagementOpen] = useState(false);
  const [cardManagementUsername, setCardManagementUsername] = useState('');
  const [cardManagementError, setCardManagementError] = useState('');
  const rfidSocketRef = useRef(null);

  // Purely cosmetic countdown — the bridge itself is what actually clears an
  // armed write after WRITE_WINDOW_SECONDS (see rfid-bridge/Program.cs); this
  // just mirrors that so whoever's watching the screen knows to hurry, and a
  // stray 'write-expired' message is still the real source of truth if this
  // ever drifts from the server's clock.
  const [cardWriteSecondsLeft, setCardWriteSecondsLeft] = useState(null);
  useEffect(() => {
    if (!cardWriteStatus || cardWriteStatus.state !== 'armed') {
      setCardWriteSecondsLeft(null);
      return;
    }
    setCardWriteSecondsLeft(WRITE_WINDOW_SECONDS);
    const interval = setInterval(() => {
      setCardWriteSecondsLeft((prev) => (prev === null ? null : Math.max(0, prev - 1)));
    }, 1000);
    return () => clearInterval(interval);
  }, [cardWriteStatus?.state, cardWriteStatus?.username]);

  // See CARD_SAFETY_NET_MS above — guarantees 'sending'/'armed' can't get
  // stuck forever even if the bridge fails to send a result or expiry
  // message. The functional-update guard makes sure this can't clobber a
  // real result that arrived just before the timer fired.
  useEffect(() => {
    if (!cardWriteStatus || (cardWriteStatus.state !== 'sending' && cardWriteStatus.state !== 'armed')) return undefined;
    const safetyTimer = setTimeout(() => {
      setCardWriteStatus((prev) =>
        prev && (prev.state === 'sending' || prev.state === 'armed')
          ? { username: prev.username, state: 'error', error: 'No response from the card reader — try again.' }
          : prev
      );
    }, CARD_SAFETY_NET_MS);
    return () => clearTimeout(safetyTimer);
  }, [cardWriteStatus?.state, cardWriteStatus?.username]);

  // Clears the Card Management input after a successful write so the next
  // person can be typed in immediately — matches the "register, tap, done,
  // repeat" rhythm instead of leaving the last name sitting there.
  useEffect(() => {
    if (
      cardWriteStatus &&
      cardWriteStatus.state === 'success' &&
      cardWriteStatus.username.toLowerCase() === cardManagementUsername.trim().toLowerCase()
    ) {
      setCardManagementUsername('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardWriteStatus]);

  // Sends a write command if the bridge is actually connected right now;
  // returns whether it was sent so callers can show "not connected" instead
  // of silently doing nothing.
  function sendCardWriteCommand(username) {
    const socket = rfidSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: 'write', username }));
    setCardWriteStatus({ username, state: 'sending' });
    return true;
  }

  // Debug-only: erases whatever card is tapped next, no matter what's on
  // it — the bridge-side blank-card guard that protects normal writes is
  // deliberately skipped for this command. Exists so a small handful of
  // physical test cards can be reused indefinitely during crash-testing
  // instead of getting permanently "used up" one at a time.
  const [cardWipeStatus, setCardWipeStatus] = useState(null); // { state: 'sending'|'armed'|'success'|'error'|'expired', error }
  function sendCardWipeCommand() {
    const socket = rfidSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: 'wipe' }));
    setCardWipeStatus({ state: 'sending' });
    return true;
  }

  // Cancel button lives only here, not on the write/registration flows —
  // this tool is tucked in the debug panel and used repeatedly while
  // testing, so backing out of an armed wipe without waiting out the full
  // window (or worse, tapping an unrelated card just to consume it) is
  // worth the extra control. Waits for the bridge's own ack before clearing
  // local state, rather than optimistically clearing it here — otherwise
  // there's a window where the UI reads "idle" but the bridge is still
  // armed and would wipe the very next card tapped regardless.
  function sendCardWipeCancelCommand() {
    const socket = rfidSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: 'cancel-wipe' }));
    return true;
  }

  const [cardWipeSecondsLeft, setCardWipeSecondsLeft] = useState(null);
  useEffect(() => {
    if (!cardWipeStatus || cardWipeStatus.state !== 'armed') {
      setCardWipeSecondsLeft(null);
      return;
    }
    setCardWipeSecondsLeft(WRITE_WINDOW_SECONDS);
    const interval = setInterval(() => {
      setCardWipeSecondsLeft((prev) => (prev === null ? null : Math.max(0, prev - 1)));
    }, 1000);
    return () => clearInterval(interval);
  }, [cardWipeStatus?.state]);

  // Same backstop as cardWriteStatus above, for the wipe tool.
  useEffect(() => {
    if (!cardWipeStatus || (cardWipeStatus.state !== 'sending' && cardWipeStatus.state !== 'armed')) return undefined;
    const safetyTimer = setTimeout(() => {
      setCardWipeStatus((prev) =>
        prev && (prev.state === 'sending' || prev.state === 'armed')
          ? { state: 'error', error: 'No response from the card reader — try again.' }
          : prev
      );
    }, CARD_SAFETY_NET_MS);
    return () => clearTimeout(safetyTimer);
  }, [cardWipeStatus?.state]);

  // Cards admin tool — re-issuing/replacing a card for an EXISTING user,
  // as opposed to the post-registration prompt's brand-new-user case.
  // Confirms the user actually exists before ever touching the bridge, so
  // a typo doesn't burn a tap on a card that would just get "user not
  // found" treatment the first time someone checks in with it.
  function handleStartCardManagementWrite(evt) {
    evt.preventDefault();
    const found = findUserByUsername(users, cardManagementUsername);
    if (!found) {
      setCardManagementError('No user with that username — check the spelling.');
      return;
    }
    setCardManagementError('');
    sendCardWriteCommand(found.username);
  }

  // RFID bridge connection — optional and silent. No bridge running is the
  // normal case for most of this app's life (no hardware yet, or the
  // helper program just isn't started); typed check-in must keep working
  // exactly as before regardless. A card read is handled as "a string
  // arrived, submit it" — the identical shape handleCheckin already
  // expects from typing, so there's no separate validation path to keep
  // in sync. Writes are the mirror image: the app asks the bridge to arm
  // itself for the next tap, then waits for a result message.
  useEffect(() => {
    let socket = null;
    let reconnectTimer = null;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      socket = new WebSocket('ws://localhost:8787/');
      rfidSocketRef.current = socket;

      // Every handler below checks identity against rfidSocketRef.current
      // before touching shared state. Without it, a stale socket's belated
      // event (e.g. React StrictMode's dev-mode double-invoke creates a
      // throwaway first connection that closes almost immediately) can fire
      // AFTER a second, genuinely-live connection has already replaced it —
      // and an unguarded onclose would null out the ref to the socket that's
      // actually still open, silently breaking every write from then on.
      socket.onopen = () => {
        if (rfidSocketRef.current === socket) setRfidBridgeConnected(true);
      };

      socket.onmessage = (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return; // malformed message — ignore, never let this crash the app
        }
        if (!data || typeof data.type !== 'string') return;

        if (data.type === 'card' && typeof data.username === 'string' && data.username.trim()) {
          setCheckinUsername(data.username); // visible in the input, same as typing
          handleCheckinRef.current(null, data.username);
        } else if (data.type === 'write-armed' && typeof data.username === 'string') {
          setCardWriteStatus({ username: data.username, state: 'armed' });
        } else if (data.type === 'write-result' && typeof data.username === 'string') {
          setCardWriteStatus({ username: data.username, state: data.success ? 'success' : 'error', error: data.error || null });
        } else if (data.type === 'write-expired' && typeof data.username === 'string') {
          setCardWriteStatus({ username: data.username, state: 'expired' });
        } else if (data.type === 'wipe-armed') {
          setCardWipeStatus({ state: 'armed' });
        } else if (data.type === 'wipe-result') {
          setCardWipeStatus({ state: data.success ? 'success' : 'error', error: data.error || null });
        } else if (data.type === 'wipe-expired') {
          setCardWipeStatus({ state: 'expired' });
        } else if (data.type === 'wipe-cancelled') {
          setCardWipeStatus(null); // back to fully idle — cancelling isn't an error or a success, just "never mind"
        }
      };
      socket.onclose = () => {
        if (rfidSocketRef.current === socket) {
          rfidSocketRef.current = null;
          setRfidBridgeConnected(false);
        }
        if (!cancelled) reconnectTimer = setTimeout(connect, 5000);
      };
      socket.onerror = () => {
        socket.close(); // falls through to onclose's reconnect
      };
    }

    connect();
    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  function handleAutoFix() {
    const { fixedUsers, fixedCount: userFixedCount } = autoFixUsers(users);
    const { fixedVisitors, fixedCount: visitorFixedCount } = autoFixVisitors(visitors);
    const fixedCount = userFixedCount + visitorFixedCount;

    saveUsers(fixedUsers);
    setUsers(fixedUsers);
    saveVisitors(fixedVisitors);
    setVisitors(fixedVisitors);

    // integrityWarnings itself is a useMemo off users/visitors/etc., so it
    // picks up fixedUsers/fixedVisitors automatically on the next render —
    // this one-off recompute is just for the message text, which needs the
    // post-fix count right now, before that render happens.
    const updatedWarnings = runIntegrityCheck(fixedUsers, checkins, fixedVisitors, events, weights);

    setAdminMessage(
      fixedCount > 0
        ? `Auto-fixed ${fixedCount} issue${fixedCount === 1 ? '' : 's'}. ${updatedWarnings.length} warning${updatedWarnings.length === 1 ? '' : 's'} remain.`
        : 'No auto-fixable issues found.'
    );
  }

  function handleMotdSubmit(evt) {
    evt.preventDefault();
    const trimmed = motdDraft.trim();
    saveMotd(trimmed);
    setMotd(trimmed);
    setMotdDraft(trimmed);
    setAdminMessage(trimmed ? 'Message posted.' : 'Message cleared.');
  }

  function handleEventFieldChange(field, value) {
    setEventForm((prev) => ({ ...prev, [field]: value }));
  }

  function handleCreateEvent(evt) {
    evt.preventDefault();
    const name = eventForm.name.trim();
    if (!name || !eventForm.startTime || !eventForm.endTime) {
      setAdminMessage('Event name, start, and end are required.');
      return;
    }

    const startDate = new Date(eventForm.startTime);
    const endDate = new Date(eventForm.endTime);
    if (endDate <= startDate) {
      setAdminMessage('Event end must be after its start.');
      return;
    }

    const newEvent = {
      id: generateEventId(events, startDate),
      name,
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString(),
      notes: eventForm.notes.trim(),
    };

    const updatedEvents = [...events, newEvent];
    saveEvents(updatedEvents);
    setEvents(updatedEvents);
    setEventForm(EMPTY_EVENT_FORM);

    // Starting in the past (or right now) means it's already within its
    // window — event mode kicks in immediately, no separate activation step.
    setAdminMessage(
      isEventActive(newEvent, new Date())
        ? `Event "${name}" created and is now active.`
        : `Event "${name}" created — will activate automatically at its start time.`
    );
  }

  function handleEndEventNow() {
    if (!currentEvent) return;
    const endedAt = new Date();
    const updatedEvents = events.map((ev) =>
      ev.id === currentEvent.id ? { ...ev, endTime: endedAt.toISOString() } : ev
    );
    saveEvents(updatedEvents);
    setEvents(updatedEvents);
    setNow(endedAt); // reflect the change immediately rather than on the next 30s tick
    setAdminMessage(`Event "${currentEvent.name}" ended.`);
  }

  function handleDeleteEvent(eventId) {
    const target = events.find((ev) => ev.id === eventId);
    const updatedEvents = events.filter((ev) => ev.id !== eventId);
    saveEvents(updatedEvents);
    setEvents(updatedEvents);
    setAdminMessage(target ? `Event "${target.name}" deleted.` : 'Event deleted.');
  }

  // Two-step, same shape as handleLogWeight: the first click just asks for
  // confirmation (button relabels) rather than overwriting every piece of
  // live data on one misclick — the second click actually commits it.
  function handleImportClick() {
    const file = importFileInputRef.current && importFileInputRef.current.files[0];
    if (!file) {
      setAdminMessage('Choose a JSON file first.');
      setImportPendingConfirm(false);
      return;
    }
    if (!importPendingConfirm) {
      setImportPendingConfirm(true);
      setAdminMessage(`This will overwrite ALL current data with "${file.name}". Click Import JSON again to confirm.`);
      return;
    }
    setImportPendingConfirm(false);
    importStateFromFile(file, (error) => {
      if (error) {
        setAdminMessage(error);
        return;
      }
      setAdminMessage('State imported successfully. Reloading…');
      // Reload rather than manually re-deriving ~10 pieces of React state
      // from the newly-written storage — simplest way to guarantee everything
      // (theme, users, checkins, events, MOTD) is actually in sync after this.
      setTimeout(() => {
        location.reload();
      }, 500);
    });
  }

  // Picking a different file after staging a confirmation should re-arm it —
  // otherwise a leftover "click again to confirm" could commit a swapped-in
  // file the admin never actually confirmed.
  function handleImportFileChange() {
    setImportPendingConfirm(false);
  }

  // Two-step: the first Enter/click validates and asks for confirmation
  // (button relabels, same form) rather than logging right away — the
  // second Enter/click on that same control actually commits it.
  function handleLogWeight(evt) {
    evt.preventDefault();
    const parsed = parseWeightInput(weightDraft);
    if (parsed.error) {
      setAdminMessage(parsed.error);
      setWeightPendingConfirm(false);
      return;
    }
    if (!weightPendingConfirm) {
      setWeightPendingConfirm(true);
      setAdminMessage(`Press Enter or click Confirm to log ${parsed.value} lbs.`);
      return;
    }
    const entry = {
      id: generateWeightId(weights),
      weightLbs: parsed.value,
      dateKey: getEasternNow().dateKey,
      timestamp: new Date().toISOString(),
    };
    const updatedWeights = [...weights, entry];
    saveWeights(updatedWeights);
    setWeights(updatedWeights);
    setWeightDraft('');
    setWeightPendingConfirm(false);
    setAdminMessage(`Logged ${parsed.value} lbs.`);
  }

  // Matched by object reference (this checkin came straight out of the
  // `checkins` array being rendered, not a clone), so no id field is needed
  // just to target it for deletion.
  function handleDeleteCheckin(checkin) {
    const updatedCheckins = checkins.filter((c) => c !== checkin);
    saveCheckins(updatedCheckins);
    setCheckins(updatedCheckins);

    // Deleting a check-in shouldn't leave the user's own denormalized
    // totalCheckins/first/lastCheckinDate/eventsAttended pointing at a
    // record that no longer exists — recompute them from what remains.
    const target = checkin.username.toLowerCase();
    const remaining = updatedCheckins
      .filter((c) => c.username.toLowerCase() === target)
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    const remainingEventIds = new Set(remaining.filter((c) => c.eventId).map((c) => c.eventId));

    const updatedUsers = users.map((u) => {
      if (u.username.toLowerCase() !== target) return u;
      return {
        ...u,
        totalCheckins: remaining.length,
        firstCheckinDate: remaining.length > 0 ? remaining[0].dateKey : null,
        lastCheckinDate: remaining.length > 0 ? remaining[remaining.length - 1].dateKey : null,
        eventsAttended: Array.isArray(u.eventsAttended)
          ? u.eventsAttended.filter((id) => remainingEventIds.has(id))
          : u.eventsAttended,
      };
    });
    saveUsers(updatedUsers);
    setUsers(updatedUsers);

    setAdminMessage('Check-in deleted.');
  }

  function handleDeleteWeight(id) {
    const updatedWeights = weights.filter((w) => w.id !== id);
    saveWeights(updatedWeights);
    setWeights(updatedWeights);
    if (editingWeightId === id) {
      setEditingWeightId(null);
      setEditWeightDraft('');
    }
    setAdminMessage('Weight entry deleted.');
  }

  function handleStartEditWeight(entry) {
    setEditingWeightId(entry.id);
    setEditWeightDraft(String(entry.weightLbs));
  }

  function handleCancelEditWeight() {
    setEditingWeightId(null);
    setEditWeightDraft('');
  }

  function handleSaveEditWeight(id) {
    const parsed = parseWeightInput(editWeightDraft);
    if (parsed.error) {
      setAdminMessage(parsed.error);
      return;
    }
    const updatedWeights = weights.map((w) => (w.id === id ? { ...w, weightLbs: parsed.value } : w));
    saveWeights(updatedWeights);
    setWeights(updatedWeights);
    setEditingWeightId(null);
    setEditWeightDraft('');
    setAdminMessage(`Updated to ${parsed.value} lbs.`);
  }

  function handleFormFieldChange(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function handleRegister(e) {
    e.preventDefault();

    const errors = validateRegistration(form, users);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) {
      setRegisterMessage('');
      return;
    }

    const baseUser = {
      username: form.username.trim(),
      email: form.email.trim(),
      phone: normalizePhone(form.phone),
      zip: form.zip.trim(),
      curbsideInterest: form.curbsideInterest,
      noCurbsideAccess: form.noCurbsideAccess,
      // Cleared rather than kept if the box ends up unchecked — otherwise
      // someone could type a building, uncheck the box, and leave stale
      // text sitting on the record under a field that reads as unset.
      buildingName: form.noCurbsideAccess ? form.buildingName.trim() : '',
      smsOptIn: form.smsOptIn,
      emailOptIn: form.emailOptIn,
      registeredDate: getEasternNow().dateKey,
      totalCheckins: 0,
      firstCheckinDate: null,
      lastCheckinDate: null,
      eventsAttended: [],
    };

    setForm(EMPTY_FORM);
    setFormErrors({});

    // Registration only auto-checks the user in when check-in is actually
    // open — same time gate as the check-in form itself. Otherwise it's
    // registration only, same as check-in would be if attempted directly.
    // debugBypassGates skips this gate too, for crash-testing.
    if (debugBypassGates || isCheckinOpen()) {
      const { dateKey } = getEasternNow();
      const newUser = applyCheckinToUser(baseUser, dateKey, null);

      const updatedUsers = [...users, newUser];
      saveUsers(updatedUsers);
      setUsers(updatedUsers);

      const updatedCheckins = [
        ...checkins,
        { username: newUser.username, dateKey, timestamp: new Date().toISOString(), eventId: null },
      ];
      saveCheckins(updatedCheckins);
      setCheckins(updatedCheckins);

      setRegisterMessage('Registration complete — you are now checked in!');
      setCheckinUsername(newUser.username);
      setCheckinMessage('Check-in successful');
    } else {
      const updatedUsers = [...users, baseUser];
      saveUsers(updatedUsers);
      setUsers(updatedUsers);

      setRegisterMessage('Registration complete.');
    }

    // New user, new opportunity to hand them a card right now while they're
    // still standing here. No click required — arming happens automatically
    // so the technician's only remaining action is the physical tap; if the
    // bridge isn't connected this is a silent no-op and the prompt below
    // just shows the "ask for a card next time" reminder instead.
    setPostRegistrationUsername(baseUser.username);
    setCardWriteStatus(null);
    sendCardWriteCommand(baseUser.username);
  }

  // Event mode's replacement for registration: no username, just email +
  // phone, logged to the separate visitors store, and always treated as an
  // event check-in (this form only exists while event mode is active, so
  // there's no separate time gate to apply — same reasoning as check-in).
  function handleVisitorCheckin(e) {
    e.preventDefault();

    const errors = validateVisitorCheckin(form);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) {
      setRegisterMessage('');
      return;
    }

    const email = form.email.trim();
    const phone = normalizePhone(form.phone);
    const { dateKey } = getEasternNow();

    setForm(EMPTY_FORM);
    setFormErrors({});

    const existing = findVisitorByPhone(visitors, phone);

    if (existing) {
      if (Array.isArray(existing.eventsAttended) && existing.eventsAttended.includes(activeEventId)) {
        setRegisterMessage("You've already checked in to this event.");
        return;
      }
      // Refresh the email on file too, in case it changed since last visit.
      const updatedVisitor = { ...applyCheckinToUser(existing, dateKey, activeEventId), email };
      const updatedVisitors = visitors.map((v) => (v.phone === phone ? updatedVisitor : v));
      saveVisitors(updatedVisitors);
      setVisitors(updatedVisitors);
      setRegisterMessage('Welcome back — you are checked in!');
    } else {
      const newVisitor = applyCheckinToUser(
        {
          id: generateVisitorId(visitors),
          email,
          phone,
          totalCheckins: 0,
          firstCheckinDate: null,
          lastCheckinDate: null,
          eventsAttended: [],
        },
        dateKey,
        activeEventId
      );
      const updatedVisitors = [...visitors, newVisitor];
      saveVisitors(updatedVisitors);
      setVisitors(updatedVisitors);
      setRegisterMessage('You are checked in!');
    }
  }

  return e('div', { className: 'app' }, [
    e('header', { className: 'app-header', key: 'header' }, [
      e('img', {
        key: 'logo',
        className: 'app-logo',
        src: '/Recycle-Here-Detroit.png',
        alt: 'Recycle Here! Detroit',
      }),
      e('h1', { key: 'title' }, 'Welcome, Recycle Heroes!'),
    ]),

    // A two-slide carousel, not a flowing marquee — .top-users-track holds
    // exactly two full-width slides (the real set, then an identical
    // aria-hidden copy) and animates by exactly one slide-width. That keeps
    // only one copy ever fully in view at once (no simultaneous repeats,
    // unlike a duplicated-strip marquee on a banner wider than the content),
    // while the swipe from slide 1 to its own identical copy is pixel-for-
    // pixel seamless — no snap back to a "first frame" to be seen, since
    // the frame it lands on IS the first frame. prefers-reduced-motion
    // turns the animation off entirely (see App.css).
    topUsersCheckins.length > 0 &&
      e(
        'div',
        { className: 'top-users-banner', key: 'top-users-banner' },
        e(
          'div',
          { className: 'top-users-track' },
          [false, true].map((isDuplicate) =>
            e(
              'div',
              { className: 'top-users-slide', key: isDuplicate ? 'dup' : 'real', 'aria-hidden': isDuplicate || undefined },
              topUsersCheckins.map((user, i) =>
                e('span', { className: 'top-user', key: user.username }, [
                  e('span', { className: 'top-user-bee', key: 'bee', 'aria-hidden': 'true' }, ['🥇', '🥈', '🥉'][i]),
                  user.username,
                ])
              )
            )
          )
        )
      ),

    // Deliberately unlabeled and tucked in a corner — this is an admin
    // utility, not part of the check-in/registration flow, and shouldn't be
    // something a regular user notices or clicks by accident.
    e('button', {
      key: 'admin-toggle',
      type: 'button',
      className: 'admin-toggle',
      title: 'Admin Panel',
      'aria-label': 'Admin Panel',
      'aria-expanded': adminOpen,
      onClick: () => {
        const isFrontmost = panelZIndex.adminPanel === panelZCounterRef.current;
        if (adminOpen && isFrontmost) {
          // Closing the whole admin panel should close Admin Tools,
          // Analytics, Debug, and Database too, rather than leaving them
          // orphaned on screen with no drawer behind them the next time.
          setAdminOpen(false);
          setAdminToolsOpen(false);
          setAnalyticsOpen(false);
          setDebugOpen(false);
          setExplorerOpen(false);
          return;
        }
        // Either it's closed (open it), or it's open but buried under
        // Admin Tools/Debug in the same corner (bring it forward without
        // closing anything).
        if (!adminOpen) setAdminOpen(true);
        panelZCounterRef.current += 1;
        setPanelZIndex((prev) => ({ ...prev, adminPanel: panelZCounterRef.current }));
      },
    }, '⚙'),

    adminOpen &&
      e(
        'div',
        {
          className: 'admin-drawer',
          key: 'admin-drawer',
          role: 'region',
          'aria-label': 'Admin Panel',
          style: { zIndex: panelZIndex.adminPanel },
        },
        [
        e('div', { className: 'admin-drawer-header', key: 'drawer-header' }, [
          e('h3', { key: 'title' }, 'Admin Panel'),
          e('div', { className: 'admin-drawer-header-actions', key: 'header-actions' }, [
            e('button', {
              key: 'admin-tools-fab',
              type: 'button',
              className: 'admin-event-fab',
              title: 'Events',
              'aria-label': 'Events',
              'aria-expanded': adminToolsOpen,
              'aria-controls': 'admin-tools-panel',
              onClick: () => toggleFloatingPanel(adminToolsOpen, setAdminToolsOpen, 'adminTools'),
            }, '📅'),
            e('button', {
              key: 'analytics-fab',
              type: 'button',
              className: 'admin-event-fab',
              title: 'Analytics',
              'aria-label': 'Analytics',
              'aria-expanded': analyticsOpen,
              'aria-controls': 'analytics-panel',
              onClick: () => toggleFloatingPanel(analyticsOpen, setAnalyticsOpen, 'analytics'),
            }, '📊'),
            e('button', {
              key: 'explorer-fab',
              type: 'button',
              className: 'admin-event-fab',
              title: 'Database',
              'aria-label': 'Database',
              'aria-expanded': explorerOpen,
              'aria-controls': 'explorer-panel',
              onClick: () => toggleFloatingPanel(explorerOpen, setExplorerOpen, 'explorer'),
            }, '🔍'),
          ]),
        ]),
        e(
          'p',
          { className: 'admin-current-event', key: 'current-event' },
          currentEvent ? `Current Event: ${currentEvent.name} (${formatEventWindow(currentEvent)})` : 'No active event'
        ),
        eventModeOverride &&
          e('p', { className: 'admin-debug-eventmode', key: 'debug-eventmode' }, 'Event Mode override: ON (debug)'),
        // Shown regardless of event mode — data-loss risk doesn't pause
        // just because an event is running. Fixing it is a Database panel
        // action (see the Automatic Backup section there), but the alert
        // itself needs to be seen without having to go looking for it first.
        backupStale &&
          e('p', { className: 'admin-backup-alert', role: 'status', key: 'backup-alert' }, '⚠ Backup overdue — see Database → Backup & Restore.'),
        // Same "surface the problem here, fix it in the Database panel"
        // split as the backup-overdue alert above — an integrity issue
        // shouldn't be invisible just because the panel where it's
        // actually addressed isn't open, but the raw count-as-a-stat and
        // the Issues/Auto-Fix controls themselves moved to the Database
        // panel's Backup & Restore tab, where imports (the main remaining
        // source of malformed data now that entry is validated everywhere
        // else) already live.
        !inEventMode && integrityWarnings.length > 0 &&
          e(
            'p',
            { className: 'admin-backup-alert', role: 'status', key: 'integrity-alert' },
            `⚠ ${integrityWarnings.length} data integrity issue${integrityWarnings.length === 1 ? '' : 's'} — see Database → Backup & Restore.`
          ),
        inEventMode &&
          e('div', { className: 'admin-stat', key: 'stat-visitor-current' }, [
            e('span', { key: 'label' }, 'Check-ins (this event)'),
            e('span', { key: 'value' }, String(eventCheckinsCurrent)),
          ]),
        inEventMode &&
          e('div', { className: 'admin-stat', key: 'stat-visitor-previous' }, [
            e('span', { key: 'label' }, 'Check-ins (last event)'),
            e('span', { key: 'value' }, String(eventCheckinsPrevious)),
          ]),
        inEventMode &&
          e('div', { className: 'admin-stat', key: 'stat-visitor-alltime' }, [
            e('span', { key: 'label' }, 'Check-ins (all-time)'),
            e('span', { key: 'value' }, String(eventCheckinsAllTime)),
          ]),

        e('form', { className: 'admin-motd-form', key: 'motd-form', onSubmit: handleMotdSubmit }, [
          e('label', { htmlFor: 'motd-input', key: 'motd-label' }, 'Message of the Day'),
          e('input', {
            key: 'motd-input',
            id: 'motd-input',
            type: 'text',
            placeholder: 'Shown above check-in — leave blank to show total stats instead',
            value: motdDraft,
            onChange: (evt) => setMotdDraft(evt.target.value),
          }),
        ]),

        adminMessage &&
          e('p', { className: 'admin-message', role: 'status', key: 'admin-message' }, adminMessage),
        e('div', { className: 'admin-version-row', key: 'version-row' }, [
          e('p', { className: 'admin-version', key: 'version' }, `Recycle Heroes v${APP_VERSION}`),
          e('div', { className: 'admin-version-row-actions', key: 'version-row-actions' }, [
            // Debug tools moved here at the user's request — next to the
            // theme toggle, both being "incidental" controls rather than
            // primary navigation, unlike Events/Analytics/Database above.
            e('button', {
              key: 'debug-fab',
              type: 'button',
              className: 'admin-event-fab',
              title: 'Debug (crash-test view)',
              'aria-label': 'Debug (crash-test view)',
              'aria-expanded': debugOpen,
              'aria-controls': 'debug-panel',
              onClick: () => toggleFloatingPanel(debugOpen, setDebugOpen, 'debug'),
            }, '🐞'),
            e('button', {
              key: 'theme-toggle',
              type: 'button',
              className: 'admin-event-fab',
              disabled: inEventMode,
              'aria-label': inEventMode
                ? 'Theme locked to dark mode during event mode'
                : theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
              title: inEventMode
                ? 'Theme locked to dark mode during event mode'
                : theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
              onClick: toggleTheme,
            }, theme === 'dark' ? '☀️' : '🌙'),
          ]),
        ]),
      ]),

    // Pops out from the 🛠️ icon in the admin drawer's header. Consolidates
    // what used to be three separate corner-anchored popovers (Create Event,
    // Data Management, Check-in Log) into one panel with tabs — same
    // corner, but nothing left to mutually exclude since only one thing
    // can occupy this panel at a time by construction.
    // Down to just event scheduling now that Data/Check-ins moved into the
    // Database panel below — a single-item tab strip would've been pointless
    // chrome, so this is back to a plain panel like it was before Admin
    // Tools grew tabs in the first place.
    adminOpen && adminToolsOpen &&
      e(
        'div',
        { className: 'admin-event-panel', key: 'admin-tools-panel', id: 'admin-tools-panel', role: 'region', 'aria-label': 'Admin Tools', style: { zIndex: panelZIndex.adminTools } },
        [
          e('div', { className: 'admin-event-panel-header', key: 'header' }, [
            e('h3', { key: 'title' }, 'Events'),
            e('button', {
              key: 'close',
              type: 'button',
              className: 'admin-event-panel-close',
              title: 'Close',
              'aria-label': 'Close',
              onClick: () => setAdminToolsOpen(false),
            }, '×'),
          ]),

          // Moved here from the main Admin Panel's corner icon row — not
          // removed, just relocated for now, to see how that row reads
          // without it. Still a debug-only override (forces event mode on
          // regardless of any real event's schedule); the always-visible
          // "Event Mode override: ON (debug)" line back in the drawer is
          // untouched, so the status stays glanceable even with this panel
          // closed — only the control itself moved.
          e('button', {
            key: 'event-mode-toggle',
            type: 'button',
            className: 'admin-io-btn',
            'aria-pressed': eventModeOverride,
            onClick: () => setEventModeOverride((prev) => !prev),
          }, eventModeOverride ? 'Event Mode Override: ON (debug)' : 'Event Mode Override: OFF (debug)'),
          currentEvent &&
            e('button', {
              key: 'end-event-btn',
              type: 'button',
              className: 'admin-end-event-btn',
              onClick: handleEndEventNow,
            }, 'End Event Now'),
          events.length > 0 &&
            e(
              'ul',
              { className: 'admin-events-list', key: 'events-list' },
              [...events].reverse().map((ev) => {
                const status = isEventActive(ev, now) ? 'active' : new Date(ev.endTime) <= now ? 'ended' : 'upcoming';
                return e('li', { className: 'admin-event-item', key: ev.id }, [
                  e('div', { className: 'admin-event-item-info', key: 'info' }, [
                    e('span', { className: `admin-event-status admin-event-status--${status}`, key: 'status' }, status),
                    e('span', { className: 'admin-event-item-name', key: 'name' }, ev.name),
                    e('span', { className: 'admin-event-item-time', key: 'time' }, formatEventWindow(ev)),
                  ]),
                  e('button', {
                    key: 'delete',
                    type: 'button',
                    className: 'admin-event-delete-btn',
                    'aria-label': `Delete event ${ev.name}`,
                    onClick: () => handleDeleteEvent(ev.id),
                  }, 'Delete'),
                ]);
              })
            ),
          e('form', { className: 'admin-event-form', key: 'event-form', onSubmit: handleCreateEvent }, [
              e('label', { htmlFor: 'event-name-input', key: 'event-name-label' }, 'Event Name'),
              e('input', {
                key: 'event-name-input',
                id: 'event-name-input',
                type: 'text',
                value: eventForm.name,
                onChange: (evt) => handleEventFieldChange('name', evt.target.value),
              }),
              e('label', { htmlFor: 'event-start-input', key: 'event-start-label' }, 'Start'),
              e('input', {
                key: 'event-start-input',
                id: 'event-start-input',
                type: 'datetime-local',
                value: eventForm.startTime,
                onChange: (evt) => handleEventFieldChange('startTime', evt.target.value),
              }),
              e('label', { htmlFor: 'event-end-input', key: 'event-end-label' }, 'End'),
              e('input', {
                key: 'event-end-input',
                id: 'event-end-input',
                type: 'datetime-local',
                value: eventForm.endTime,
                onChange: (evt) => handleEventFieldChange('endTime', evt.target.value),
              }),
              e('label', { htmlFor: 'event-notes-input', key: 'event-notes-label' }, 'Notes (optional)'),
              e('input', {
                key: 'event-notes-input',
                id: 'event-notes-input',
                type: 'text',
                value: eventForm.notes,
                onChange: (evt) => handleEventFieldChange('notes', evt.target.value),
              }),
              e('button', { key: 'event-submit', type: 'submit', className: 'admin-event-submit' }, 'Create Event'),
            ]),
        ]
      ),

    // Crash-test aid, not a beta feature — a live view of the numbers that
    // matter while running a full registration → activation → check-in pass
    // repeatedly, without having to switch Admin Tools tabs mid-test. Reads
    // users/checkins directly, so it updates on every render exactly like
    // the rest of the app already does — no separate polling needed.
    adminOpen && debugOpen &&
      e(
        'div',
        { className: 'admin-event-panel', key: 'debug-panel', id: 'debug-panel', role: 'region', 'aria-label': 'Debug', style: { zIndex: panelZIndex.debug } },
        [
          e('div', { className: 'admin-event-panel-header', key: 'header' }, [
            e('h3', { key: 'title' }, 'Debug (crash-test view)'),
            e('button', {
              key: 'close',
              type: 'button',
              className: 'admin-event-panel-close',
              title: 'Close',
              'aria-label': 'Close',
              onClick: () => setDebugOpen(false),
            }, '×'),
          ]),
          e('div', { className: 'debug-stats', key: 'stats' }, [
            e('div', { className: 'debug-stat', key: 'users' }, [
              e('span', { className: 'debug-stat-value', key: 'value' }, users.length.toLocaleString()),
              e('span', { className: 'debug-stat-label', key: 'label' }, 'Total Users'),
            ]),
            e('div', { className: 'debug-stat', key: 'checkins' }, [
              e('span', { className: 'debug-stat-value', key: 'value' }, checkins.length.toLocaleString()),
              e('span', { className: 'debug-stat-label', key: 'label' }, 'Total Check-ins'),
            ]),
            e('div', { className: 'debug-stat', key: 'today' }, [
              e(
                'span',
                { className: 'debug-stat-value', key: 'value' },
                checkins.filter((c) => c.dateKey === getEasternNow().dateKey).length.toLocaleString()
              ),
              e('span', { className: 'debug-stat-label', key: 'label' }, "Today's Check-ins"),
            ]),
          ]),
          e(
            'label',
            { className: 'checkbox-label checkbox-label--compact debug-bypass-toggle', htmlFor: 'debug-bypass-gates', key: 'bypass' },
            [
              e('input', {
                key: 'input',
                id: 'debug-bypass-gates',
                type: 'checkbox',
                checked: debugBypassGates,
                onChange: (evt) => setDebugBypassGates(evt.target.checked),
              }),
              'Bypass check-in rules (hours + daily/event limit)',
            ]
          ),
          debugBypassGates &&
            e(
              'p',
              { className: 'admin-debug-eventmode', key: 'bypass-note' },
              `Bypass is ON — check-in works any time, repeatedly, for any user. Off resumes the real gate (${CHECKIN_HOURS_TEXT}).`
            ),

          // Debug-only wipe control — reclaims one of a small number of
          // physical test cards for reuse instead of needing an endless
          // supply of blanks. Bypasses the bridge's normal "never overwrite
          // an already-programmed card" guard on purpose.
          e('p', { className: 'debug-recent-heading', key: 'wipe-heading' }, 'Reuse a test card'),
          e(
            'p',
            { className: 'admin-cards-status-off', key: 'wipe-warning' },
            "Erases whatever card is tapped next — even one that's already programmed. Use this to get a test card back instead of using up your last blank."
          ),
          !rfidBridgeConnected &&
            e('p', { className: 'admin-cards-status-off', key: 'wipe-no-bridge' }, 'Card reader not connected.'),
          rfidBridgeConnected &&
            (!cardWipeStatus || ['success', 'error', 'expired'].includes(cardWipeStatus.state)) &&
            e(
              'button',
              { key: 'wipe-btn', type: 'button', className: 'admin-io-btn', onClick: () => sendCardWipeCommand() },
              'Arm Wipe (tap next card to erase)'
            ),
          cardWipeStatus &&
            cardWipeStatus.state === 'sending' &&
            e('p', { className: 'card-program-note', key: 'wipe-sending' }, 'Arming the card reader...'),
          cardWipeStatus &&
            cardWipeStatus.state === 'armed' &&
            e(
              'p',
              { className: 'card-program-armed', key: 'wipe-armed' },
              `Tap the card to erase now... (${cardWipeSecondsLeft ?? WRITE_WINDOW_SECONDS}s)`
            ),
          cardWipeStatus &&
            (cardWipeStatus.state === 'sending' || cardWipeStatus.state === 'armed') &&
            e(
              'button',
              { key: 'wipe-cancel-btn', type: 'button', className: 'admin-io-btn', onClick: () => sendCardWipeCancelCommand() },
              'Cancel'
            ),
          cardWipeStatus &&
            cardWipeStatus.state === 'expired' &&
            e('p', { className: 'card-program-error', key: 'wipe-expired' }, "Time's up — no card was tapped."),
          cardWipeStatus &&
            cardWipeStatus.state === 'success' &&
            e('p', { className: 'card-program-success', key: 'wipe-success' }, 'Card wiped — ready to reuse.'),
          cardWipeStatus &&
            cardWipeStatus.state === 'error' &&
            e(
              'p',
              { className: 'card-program-error', key: 'wipe-error' },
              `Wipe didn't work: ${cardWipeStatus.error || 'unknown error'}`
            ),

          e('p', { className: 'debug-recent-heading', key: 'recent-heading' }, 'Most recent check-ins'),
          checkins.length === 0
            ? e('p', { className: 'admin-cards-status-off', key: 'recent-empty' }, 'None yet.')
            : e(
                'ul',
                { className: 'admin-weight-list', key: 'recent-list' },
                [...checkins]
                  .slice(-5)
                  .reverse()
                  .map((c, i) =>
                    e('li', { className: 'admin-weight-item', key: `${c.username}-${c.timestamp}-${i}` }, [
                      e('div', { className: 'admin-weight-item-info', key: 'info' }, [
                        e('span', { className: 'admin-weight-item-lbs', key: 'user' }, c.username),
                        e(
                          'span',
                          { className: 'admin-weight-item-date', key: 'date' },
                          new Date(c.timestamp).toLocaleTimeString()
                        ),
                      ]),
                    ])
                  )
              ),
        ]
      ),

    // Pops out from the 📊 icon, centered on screen since a usable map needs
    // more room than a corner popover. Heat Map and Leaderboard are tabs of
    // one panel rather than two separately-toggled ones — but unlike the
    // Admin Tools tabs, both tab bodies stay mounted (toggled via CSS, not
    // conditional rendering) so switching away from Heat Map doesn't tear
    // down the Leaflet map instance and lose its pan/zoom/filter state.
    adminOpen && analyticsOpen &&
      e(
        'div',
        { className: 'admin-map-panel', key: 'analytics-panel', id: 'analytics-panel', role: 'region', 'aria-label': 'Analytics', style: { zIndex: panelZIndex.analytics } },
        [
          e('div', { className: 'admin-map-panel-header', key: 'header' }, [
            e('h3', { key: 'title' }, 'Analytics'),
            e('button', {
              key: 'close',
              type: 'button',
              className: 'admin-event-panel-close',
              title: 'Close',
              'aria-label': 'Close',
              onClick: () => setAnalyticsOpen(false),
            }, '×'),
          ]),
          // Program-wide totals, not any one tab's concern — shown once,
          // above the tab strip, so they stay visible no matter which view
          // is open. Moved here from the main Admin Panel: those are raw
          // numbers to look at, not admin actions to take, so Analytics is
          // where they belong now. (Integrity warnings/Issues/Auto-Fix
          // later moved too, to the Database panel's Backup & Restore tab —
          // an action, not a view, so it lives with Import rather than here.)
          e('div', { className: 'analytics-totals', key: 'totals' }, [
            e('div', { className: 'analytics-stat-tile', key: 'tile-users' }, [
              e('span', { className: 'analytics-stat-value', key: 'value' }, users.length.toLocaleString()),
              e('span', { className: 'analytics-stat-label', key: 'label' }, 'Total Users'),
            ]),
            e('div', { className: 'analytics-stat-tile', key: 'tile-checkins' }, [
              e('span', { className: 'analytics-stat-value', key: 'value' }, checkins.length.toLocaleString()),
              e('span', { className: 'analytics-stat-label', key: 'label' }, 'Total Check-ins'),
            ]),
            e('div', { className: 'analytics-stat-tile', key: 'tile-weight' }, [
              e('span', { className: 'analytics-stat-value', key: 'value' }, `${totalWeightLoggedLbs(weights).toLocaleString()} lbs`),
              e('span', { className: 'analytics-stat-label', key: 'label' }, 'Total Waste Diverted'),
            ]),
          ]),
          e('div', { className: 'admin-tab-strip', key: 'tabs', role: 'tablist' }, [
            e('button', {
              key: 'tab-heatmap',
              type: 'button',
              className: analyticsTab === 'heatmap' ? 'active' : undefined,
              role: 'tab',
              'aria-selected': analyticsTab === 'heatmap',
              onClick: () => setAnalyticsTab('heatmap'),
            }, 'Heat Map'),
            e('button', {
              key: 'tab-leaderboard',
              type: 'button',
              className: analyticsTab === 'leaderboard' ? 'active' : undefined,
              role: 'tab',
              'aria-selected': analyticsTab === 'leaderboard',
              onClick: () => setAnalyticsTab('leaderboard'),
            }, 'Leaderboard'),
            e('button', {
              key: 'tab-patterns',
              type: 'button',
              className: analyticsTab === 'patterns' ? 'active' : undefined,
              role: 'tab',
              'aria-selected': analyticsTab === 'patterns',
              onClick: () => setAnalyticsTab('patterns'),
            }, 'Patterns'),
            e('button', {
              key: 'tab-achievements',
              type: 'button',
              className: analyticsTab === 'achievements' ? 'active' : undefined,
              role: 'tab',
              'aria-selected': analyticsTab === 'achievements',
              onClick: () => setAnalyticsTab('achievements'),
            }, 'Achievements'),
          ]),
          e(
            'div',
            { className: analyticsTab === 'heatmap' ? undefined : 'admin-tab-hidden', key: 'heatmap-tab' },
            [e(ZipHeatMap, { users, checkins, key: 'heatmap' })]
          ),
          e(
            'div',
            { className: analyticsTab === 'leaderboard' ? undefined : 'admin-tab-hidden', key: 'leaderboard-tab' },
            [
              e('div', { className: 'leaderboard-row', key: 'zips-row' }, [
                e('div', { className: 'leaderboard-section', key: 'zips-users' }, [
                  e('h4', { key: 'h4' }, 'Top 5 ZIP Codes by Registered Users'),
                  topZipsUsers.length === 0
                    ? e('p', { className: 'leaderboard-empty', key: 'empty' }, 'No data yet.')
                    : e(
                        'ol',
                        { className: 'leaderboard-list', key: 'list' },
                        topZipsUsers.map((row, i) =>
                          e('li', { key: row.zip }, [
                            e('span', { className: 'leaderboard-rank', key: 'rank' }, `#${i + 1}`),
                            e('span', { className: 'leaderboard-label', key: 'label' }, row.zip),
                            e('span', { className: 'leaderboard-value', key: 'value' }, `${row.count} user${row.count === 1 ? '' : 's'}`),
                          ])
                        )
                      ),
                ]),
                e('div', { className: 'leaderboard-section', key: 'zips-activity' }, [
                  e('h4', { key: 'h4' }, 'Top 5 ZIP Codes by Activity (All Time)'),
                  topZipsActivity.length === 0
                    ? e('p', { className: 'leaderboard-empty', key: 'empty' }, 'No data yet.')
                    : e(
                        'ol',
                        { className: 'leaderboard-list', key: 'list' },
                        topZipsActivity.map((row, i) =>
                          e('li', { key: row.zip }, [
                            e('span', { className: 'leaderboard-rank', key: 'rank' }, `#${i + 1}`),
                            e('span', { className: 'leaderboard-label', key: 'label' }, row.zip),
                            e('span', { className: 'leaderboard-value', key: 'value' }, `${row.count} check-in${row.count === 1 ? '' : 's'}`),
                          ])
                        )
                      ),
                ]),
              ]),
              e('div', { className: 'leaderboard-section', key: 'users-checkins' }, [
                e('h4', { key: 'h4' }, 'Top 3 Users by Check-Ins'),
                topUsersCheckins.length === 0
                  ? e('p', { className: 'leaderboard-empty', key: 'empty' }, 'No data yet.')
                  : e(
                      'ol',
                      { className: 'leaderboard-list', key: 'list' },
                      topUsersCheckins.map((user, i) =>
                        e('li', { key: user.username }, [
                          e('span', { className: 'leaderboard-rank', key: 'rank' }, `#${i + 1}`),
                          e('span', { className: 'leaderboard-label', key: 'label' }, user.username),
                          e('span', { className: 'leaderboard-value', key: 'value' }, `${user.totalCheckins} check-in${user.totalCheckins === 1 ? '' : 's'}`),
                        ])
                      )
                    ),
              ]),
              e('div', { className: 'leaderboard-section', key: 'lowest-participation' }, [
                e('h4', { key: 'h4' }, 'Lowest Participation ZIPs (Last 30 Days)'),
                lowestParticipationZips.length === 0
                  ? e('p', { className: 'leaderboard-empty', key: 'empty' }, 'No data yet.')
                  : e(
                      'ol',
                      { className: 'leaderboard-list', key: 'list' },
                      lowestParticipationZips.map((row, i) =>
                        e('li', { key: row.zip }, [
                          e('span', { className: 'leaderboard-rank', key: 'rank' }, `#${i + 1}`),
                          e('span', { className: 'leaderboard-label', key: 'label' }, row.zip),
                          e(
                            'span',
                            { className: 'leaderboard-value', key: 'value' },
                            `${row.current} this month${row.delta !== 0 ? ` (${row.delta > 0 ? '+' : ''}${row.delta})` : ''}`
                          ),
                        ])
                      )
                    ),
              ]),
            ]
          ),
          e(
            'div',
            { className: analyticsTab === 'patterns' ? undefined : 'admin-tab-hidden', key: 'patterns-tab' },
            [
              e(
                'p',
                { className: 'admin-checkin-count', key: 'intro' },
                'Average check-ins per 15 minutes, by day — a first pass, worth revisiting once there\'s more real data to average over.'
              ),
              ...checkinPatterns.map((dayData) => {
                const dayLabel = { 1: 'Monday', 3: 'Wednesday', 6: 'Saturday' }[dayData.day];
                const labeledSlots = dayData.slots.map((s) => ({ ...s, label: formatTimeSlotLabel(s.slot) }));
                return e('div', { className: 'leaderboard-section', key: `day-${dayData.day}` }, [
                  e('h4', { key: 'h4' }, dayLabel),
                  e(PatternChart, { key: 'chart', slots: labeledSlots, sessionCount: dayData.sessionCount }),
                ]);
              }),
            ]
          ),
          e(
            'div',
            { className: analyticsTab === 'achievements' ? undefined : 'admin-tab-hidden', key: 'achievements-tab' },
            [
              e(
                'p',
                { className: 'admin-checkin-count', key: 'intro' },
                achievements.activeCount === 0
                  ? 'No active users yet — badges will populate once check-ins start coming in.'
                  : `Badges earned across ${achievements.activeCount} active user${achievements.activeCount === 1 ? '' : 's'} (at least one lifetime check-in). Admin-only for now — a first read on what retention looks like beneath the raw numbers.`
              ),
              ...ACHIEVEMENT_GROUPS.map((group) => {
                const groupBadges = achievements.badges.filter((b) => b.group === group);
                return e('div', { className: 'leaderboard-section', key: `group-${group}` }, [
                  e('h4', { key: 'h4' }, group),
                  e(
                    'ol',
                    { className: 'achievement-list', key: 'list' },
                    groupBadges.map((badge) =>
                      e('li', { className: 'achievement-row', key: badge.id }, [
                        e('span', { className: 'achievement-icon', key: 'icon', 'aria-hidden': 'true' }, badge.emoji),
                        e('div', { className: 'achievement-info', key: 'info' }, [
                          e('span', { className: 'achievement-name', key: 'name' }, badge.name),
                          e('span', { className: 'achievement-desc', key: 'desc' }, badge.description),
                        ]),
                        e('div', { className: 'achievement-stats', key: 'stats' }, [
                          e('span', { className: 'achievement-pct', key: 'pct' }, `${badge.pct}%`),
                          e(
                            'span',
                            { className: 'achievement-count', key: 'count' },
                            `${badge.earnedCount} of ${achievements.activeCount}`
                          ),
                        ]),
                      ])
                    )
                  ),
                ]);
              }),
            ]
          ),
        ]
      ),

    // Database — the single home for Users, Check-ins, Weight Log, and
    // Backup & Restore, consolidated out of the old separate "Data"/
    // "Check-ins" Admin Tools tabs and the standalone username-recovery
    // widget once those had become redundant with the Users tab's own
    // search/filter/export. Its own wide, centered panel rather than a tab
    // inside Admin Tools' 360px corner popover, for the same reason
    // Analytics got one: a real data table needs more room to read cleanly.
    adminOpen && explorerOpen &&
      e(
        'div',
        { className: 'admin-map-panel', key: 'explorer-panel', id: 'explorer-panel', role: 'region', 'aria-label': 'Database', style: { zIndex: panelZIndex.explorer } },
        [
          e('div', { className: 'admin-map-panel-header', key: 'header' }, [
            e('h3', { key: 'title' }, 'Database'),
            e('button', {
              key: 'close',
              type: 'button',
              className: 'admin-event-panel-close',
              title: 'Close',
              'aria-label': 'Close',
              onClick: () => setExplorerOpen(false),
            }, '×'),
          ]),
          e('div', { className: 'admin-tab-strip', key: 'tabs', role: 'tablist' }, [
            e('button', {
              key: 'tab-users',
              type: 'button',
              className: explorerPanelTab === 'users' ? 'active' : undefined,
              role: 'tab',
              'aria-selected': explorerPanelTab === 'users',
              onClick: () => setExplorerPanelTab('users'),
            }, 'Users'),
            e('button', {
              key: 'tab-checkins',
              type: 'button',
              className: explorerPanelTab === 'checkins' ? 'active' : undefined,
              role: 'tab',
              'aria-selected': explorerPanelTab === 'checkins',
              onClick: () => setExplorerPanelTab('checkins'),
            }, 'Check-ins'),
            e('button', {
              key: 'tab-weights',
              type: 'button',
              className: explorerPanelTab === 'weights' ? 'active' : undefined,
              role: 'tab',
              'aria-selected': explorerPanelTab === 'weights',
              onClick: () => setExplorerPanelTab('weights'),
            }, 'Weight Log'),
            e('button', {
              key: 'tab-backup',
              type: 'button',
              className: explorerPanelTab === 'backup' ? 'active' : undefined,
              role: 'tab',
              'aria-selected': explorerPanelTab === 'backup',
              onClick: () => setExplorerPanelTab('backup'),
            }, 'Backup & Restore'),
          ]),
          explorerPanelTab === 'users' &&
          e('div', { className: 'explorer-users-tab', key: 'users-tab' }, [
          e('input', {
            key: 'search',
            type: 'text',
            className: 'admin-checkin-search',
            placeholder: 'Search username, email, phone, ZIP, building…',
            value: explorerFilters.search,
            onChange: (evt) => handleExplorerFilterChange('search', evt.target.value),
          }),

          e('div', { className: 'explorer-filters', key: 'filters' }, [
            e('label', { className: 'explorer-filter', key: 'zip' }, [
              'ZIP',
              e('input', {
                key: 'input',
                type: 'text',
                value: explorerFilters.zip,
                onChange: (evt) => handleExplorerFilterChange('zip', evt.target.value),
              }),
            ]),
            e('label', { className: 'explorer-filter', key: 'curbside' }, [
              'Wants Curbside',
              e(
                'select',
                {
                  key: 'input',
                  value: explorerFilters.curbsideInterest,
                  onChange: (evt) => handleExplorerFilterChange('curbsideInterest', evt.target.value),
                },
                [
                  e('option', { key: 'any', value: 'any' }, 'Any'),
                  e('option', { key: 'yes', value: 'yes' }, 'Yes'),
                  e('option', { key: 'no', value: 'no' }, 'No'),
                ]
              ),
            ]),
            e('label', { className: 'explorer-filter', key: 'no-curbside' }, [
              'No Curbside Access',
              e(
                'select',
                {
                  key: 'input',
                  value: explorerFilters.noCurbsideAccess,
                  onChange: (evt) => handleExplorerFilterChange('noCurbsideAccess', evt.target.value),
                },
                [
                  e('option', { key: 'any', value: 'any' }, 'Any'),
                  e('option', { key: 'yes', value: 'yes' }, 'Yes'),
                  e('option', { key: 'no', value: 'no' }, 'No'),
                ]
              ),
            ]),
            e('label', { className: 'explorer-filter', key: 'opted-in' }, [
              'Opted In to Updates',
              e(
                'select',
                {
                  key: 'input',
                  value: explorerFilters.optedIn,
                  onChange: (evt) => handleExplorerFilterChange('optedIn', evt.target.value),
                },
                [
                  e('option', { key: 'any', value: 'any' }, 'Any'),
                  e('option', { key: 'yes', value: 'yes' }, 'Yes'),
                  e('option', { key: 'no', value: 'no' }, 'No'),
                ]
              ),
            ]),
            e('label', { className: 'explorer-filter', key: 'min-checkins' }, [
              'Min. Check-ins',
              e('input', {
                key: 'input',
                type: 'number',
                min: 0,
                value: explorerFilters.minCheckins,
                onChange: (evt) => handleExplorerFilterChange('minCheckins', evt.target.value),
              }),
            ]),
            e('label', { className: 'explorer-filter', key: 'registered-from' }, [
              'Registered From',
              e('input', {
                key: 'input',
                type: 'date',
                value: explorerFilters.registeredFrom,
                onChange: (evt) => handleExplorerFilterChange('registeredFrom', evt.target.value),
              }),
            ]),
            e('label', { className: 'explorer-filter', key: 'registered-to' }, [
              'Registered To',
              e('input', {
                key: 'input',
                type: 'date',
                value: explorerFilters.registeredTo,
                onChange: (evt) => handleExplorerFilterChange('registeredTo', evt.target.value),
              }),
            ]),
          ]),

          e('div', { className: 'explorer-column-picker', key: 'columns' }, [
            e('span', { className: 'explorer-column-picker-label', key: 'label' }, 'Columns:'),
            ...EXPLORER_COLUMNS.map((c) =>
              e(
                'label',
                { className: 'checkbox-label checkbox-label--compact', key: c.key },
                [
                  e('input', {
                    key: 'input',
                    type: 'checkbox',
                    checked: Boolean(explorerVisibleColumns[c.key]),
                    onChange: () => handleExplorerColumnToggle(c.key),
                  }),
                  c.label,
                ]
              )
            ),
          ]),

          e('div', { className: 'explorer-toolbar', key: 'toolbar' }, [
            e(
              'button',
              { key: 'reset', type: 'button', className: 'admin-io-btn', onClick: () => setExplorerFilters(EMPTY_EXPLORER_FILTERS) },
              'Reset Filters'
            ),
            e(
              'button',
              {
                key: 'export',
                type: 'button',
                className: 'admin-io-btn',
                disabled: matchingExplorerUsers.length === 0 || explorerVisibleColumnKeys.length === 0,
                onClick: () => exportExplorerDatasetAsCSV(matchingExplorerUsers, explorerVisibleColumnKeys),
              },
              `Export Custom Dataset (${matchingExplorerUsers.length})`
            ),
          ]),

          e(
            'p',
            { className: 'admin-checkin-count', key: 'count' },
            matchingExplorerUsers.length === 0
              ? 'No users match these filters.'
              : `Showing ${shownExplorerUsers.length} of ${matchingExplorerUsers.length} user${matchingExplorerUsers.length === 1 ? '' : 's'}.`
          ),

          explorerVisibleColumnDefs.length === 0
            ? e('p', { className: 'admin-cards-status-off', key: 'no-columns' }, 'Pick at least one column above to display.')
            : e('div', { className: 'explorer-table-wrap', key: 'table-wrap' }, [
                e('table', { className: 'explorer-table', key: 'table' }, [
                  e(
                    'thead',
                    { key: 'thead' },
                    e(
                      'tr',
                      { key: 'tr' },
                      explorerVisibleColumnDefs.map((c) =>
                        e(
                          'th',
                          {
                            key: c.key,
                            onClick: () => handleExplorerSortClick(c.key),
                            className: explorerSortField === c.key ? 'explorer-sort-active' : undefined,
                            'aria-sort': explorerSortField === c.key ? (explorerSortDir === 'asc' ? 'ascending' : 'descending') : undefined,
                          },
                          `${c.label}${explorerSortField === c.key ? (explorerSortDir === 'asc' ? ' ▲' : ' ▼') : ''}`
                        )
                      )
                    )
                  ),
                  e(
                    'tbody',
                    { key: 'tbody' },
                    shownExplorerUsers.map((u) =>
                      e(
                        'tr',
                        { key: u.username },
                        explorerVisibleColumnDefs.map((c) => {
                          const raw = c.value(u);
                          return e('td', { key: c.key }, String(c.format ? c.format(raw) : raw ?? ''));
                        })
                      )
                    )
                  ),
                ]),
              ]),
          ]),

          explorerPanelTab === 'checkins' &&
            e('div', { className: 'explorer-checkins-tab', key: 'checkins-tab' }, [
              e('input', {
                key: 'search',
                type: 'text',
                className: 'admin-checkin-search',
                placeholder: 'Search by username…',
                value: checkinSearch,
                onChange: (evt) => setCheckinSearch(evt.target.value),
              }),
              e(
                'p',
                { className: 'admin-checkin-count', key: 'count' },
                matchingCheckins.length === 0
                  ? checkinSearchQuery
                    ? `No check-ins match "${checkinSearch.trim()}".`
                    : 'No check-ins yet.'
                  : `Showing ${shownCheckins.length} of ${matchingCheckins.length}${checkinSearchQuery ? ' matching' : ''} check-in${matchingCheckins.length === 1 ? '' : 's'}.`
              ),
              e('div', { className: 'explorer-toolbar', key: 'toolbar' }, [
                e(
                  'button',
                  {
                    key: 'export',
                    type: 'button',
                    className: 'admin-io-btn',
                    disabled: matchingCheckins.length === 0,
                    title: 'Export Check-ins (CSV)',
                    onClick: () => exportCheckinsAsCSV(matchingCheckins),
                  },
                  `Export ${checkinSearchQuery ? 'Matching' : 'All'} Check-ins (${matchingCheckins.length})`
                ),
              ]),
              shownCheckins.length > 0 &&
                e(
                  'ul',
                  { className: 'admin-weight-list', key: 'list' },
                  shownCheckins.map((checkin) =>
                    // timestamp alone isn't guaranteed unique (e.g. bulk-generated
                    // test data can collide at minute precision) — pair it with
                    // username so React's reconciliation can't cross-match rows.
                    e('li', { className: 'admin-weight-item', key: `${checkin.username}-${checkin.timestamp}` }, [
                      e('div', { className: 'admin-weight-item-info', key: 'info' }, [
                        e('span', { className: 'admin-weight-item-lbs', key: 'user' }, checkin.username),
                        e(
                          'span',
                          { className: 'admin-weight-item-date', key: 'date' },
                          checkin.eventId ? `${checkin.dateKey} • event` : checkin.dateKey
                        ),
                      ]),
                      e('button', {
                        key: 'delete',
                        type: 'button',
                        className: 'admin-event-delete-btn',
                        'aria-label': `Delete check-in for ${checkin.username} on ${checkin.dateKey}`,
                        onClick: () => handleDeleteCheckin(checkin),
                      }, 'Delete'),
                    ])
                  )
                ),
            ]),

          explorerPanelTab === 'weights' &&
            e('div', { className: 'explorer-weights-tab', key: 'weights-tab' }, [
              e('form', { className: 'admin-weight-form', key: 'weight-form', onSubmit: handleLogWeight }, [
                e('label', { htmlFor: 'weight-input', key: 'weight-label' }, 'Log Weight (lbs)'),
                e('div', { className: 'admin-weight-row', key: 'weight-row' }, [
                  e('input', {
                    key: 'weight-input',
                    id: 'weight-input',
                    type: 'number',
                    min: '0',
                    step: '0.1',
                    inputMode: 'decimal',
                    value: weightDraft,
                    onChange: (evt) => {
                      setWeightDraft(evt.target.value);
                      if (weightPendingConfirm) setWeightPendingConfirm(false);
                    },
                  }),
                  e(
                    'button',
                    { key: 'weight-submit', type: 'submit', className: 'admin-io-btn' },
                    weightPendingConfirm ? 'Confirm' : 'Log Weight'
                  ),
                ]),
              ]),
              weights.length > 0 &&
                e('div', { className: 'admin-io-row', key: 'weight-log-row' }, [
                  e('button', {
                    key: 'weight-log-toggle',
                    type: 'button',
                    className: 'admin-io-btn',
                    'aria-expanded': weightLogOpen,
                    'aria-controls': 'weight-log-list',
                    onClick: () => setWeightLogOpen((prev) => !prev),
                  }, weightLogOpen ? 'Hide Log' : `Weight Log (${weights.length})`),
                ]),
              weights.length > 0 &&
                weightLogOpen &&
                e(
                  'ul',
                  { className: 'admin-weight-list', id: 'weight-log-list', key: 'weight-log-list' },
                  [...weights].reverse().map((entry) =>
                    e(
                      'li',
                      { className: 'admin-weight-item', key: entry.id },
                      editingWeightId === entry.id
                        ? [
                            e('input', {
                              key: 'edit-input',
                              type: 'number',
                              min: '0',
                              step: '0.1',
                              className: 'admin-weight-edit-input',
                              value: editWeightDraft,
                              onChange: (evt) => setEditWeightDraft(evt.target.value),
                            }),
                            e('div', { className: 'admin-weight-item-actions', key: 'edit-actions' }, [
                              e('button', {
                                key: 'save',
                                type: 'button',
                                className: 'admin-weight-save-btn',
                                onClick: () => handleSaveEditWeight(entry.id),
                              }, 'Save'),
                              e('button', {
                                key: 'cancel',
                                type: 'button',
                                className: 'admin-weight-cancel-btn',
                                onClick: handleCancelEditWeight,
                              }, 'Cancel'),
                            ]),
                          ]
                        : [
                            e('div', { className: 'admin-weight-item-info', key: 'info' }, [
                              e('span', { className: 'admin-weight-item-lbs', key: 'lbs' }, `${entry.weightLbs} lbs`),
                              e('span', { className: 'admin-weight-item-date', key: 'date' }, entry.dateKey),
                            ]),
                            e('div', { className: 'admin-weight-item-actions', key: 'actions' }, [
                              e('button', {
                                key: 'edit',
                                type: 'button',
                                className: 'admin-weight-edit-btn',
                                'aria-label': `Edit weight entry ${entry.dateKey}`,
                                onClick: () => handleStartEditWeight(entry),
                              }, 'Edit'),
                              e('button', {
                                key: 'delete',
                                type: 'button',
                                className: 'admin-event-delete-btn',
                                'aria-label': `Delete weight entry ${entry.dateKey}`,
                                onClick: () => handleDeleteWeight(entry.id),
                              }, 'Delete'),
                            ]),
                          ]
                    )
                  )
                ),
              adminMessage && e('p', { className: 'admin-message', role: 'status', key: 'weights-message' }, adminMessage),
            ]),

          explorerPanelTab === 'backup' &&
            e('div', { className: 'explorer-backup-tab', key: 'backup-tab' }, [
              e('div', { className: 'admin-backup-section', key: 'backup' }, [
                e('h4', { key: 'h4' }, 'Automatic Backup'),
                backupStale &&
                  e(
                    'p',
                    { className: 'admin-backup-warning', key: 'status' },
                    lastBackupAt
                      ? `No backup in over 24 hours (last: ${formatBackupTimestamp(lastBackupAt)}).`
                      : 'No backup on record yet.'
                  ),
                !backupStale &&
                  lastBackupAt &&
                  e('p', { className: 'admin-backup-ok', key: 'status' }, `Last backup: ${formatBackupTimestamp(lastBackupAt)}.`),
                backupFolderName &&
                  e(
                    'p',
                    { className: 'admin-checkin-count', key: 'folder' },
                    `Saving automatically to "${backupFolderName}" once a day.`
                  ),
                !backupFolderName &&
                  backupSupported &&
                  e(
                    'p',
                    { className: 'admin-checkin-count', key: 'not-configured' },
                    'Not set up yet — pick a folder to enable daily automatic backups, or export manually below.'
                  ),
                !backupSupported &&
                  e(
                    'p',
                    { className: 'admin-checkin-count', key: 'unsupported' },
                    'Automatic backup needs Chrome or Edge on this device. Export manually below to stay protected.'
                  ),
                e('div', { className: 'admin-io-row', key: 'backup-actions' }, [
                  backupSupported &&
                    e(
                      'button',
                      { key: 'setup', type: 'button', className: 'admin-io-btn', onClick: handleSetupBackup },
                      backupFolderName ? 'Change Backup Folder' : 'Set Up Automatic Backup'
                    ),
                  backupFolderName &&
                    e(
                      'button',
                      { key: 'disconnect', type: 'button', className: 'admin-io-btn', onClick: handleDisconnectBackup },
                      'Turn Off'
                    ),
                  // "Backup Now" and the old "Export JSON" button used to be
                  // two separately-labeled buttons calling the exact same
                  // handler — real, if harmless, redundancy. One button now.
                  e(
                    'button',
                    { key: 'manual', type: 'button', className: 'admin-io-btn', onClick: handleManualBackup },
                    'Backup Now (JSON)'
                  ),
                ]),
                backupMessage && e('p', { className: 'admin-message', role: 'status', key: 'backup-message' }, backupMessage),
              ]),
              e('div', { className: 'admin-io-row admin-io-row--wrap', key: 'io-row' }, [
                e('button', {
                  key: 'import-state-btn',
                  type: 'button',
                  className: 'admin-io-btn',
                  title: 'Import Full State (JSON)',
                  onClick: handleImportClick,
                }, importPendingConfirm ? 'Confirm Import' : 'Import JSON'),
              ]),
              e('input', {
                key: 'import-file-input',
                type: 'file',
                accept: 'application/json',
                ref: importFileInputRef,
                className: 'admin-import-input',
                onChange: handleImportFileChange,
              }),

              // Moved here from a static, never-refreshing count in the
              // Admin Panel drawer — now a live check (see the
              // integrityWarnings useMemo above) and an actual actionable
              // feature, positioned next to Import since a bad import is
              // the main remaining way malformed data gets in now that
              // entry is validated everywhere else.
              e('div', { className: 'admin-backup-section', key: 'integrity' }, [
                e('h4', { key: 'h4' }, 'Data Integrity'),
                integrityWarnings.length === 0
                  ? e('p', { className: 'admin-backup-ok', key: 'status' }, '✓ No integrity issues found.')
                  : e(
                      'p',
                      { className: 'admin-backup-warning', key: 'status' },
                      `${integrityWarnings.length} issue${integrityWarnings.length === 1 ? '' : 's'} found.`
                    ),
                integrityWarnings.length > 0 &&
                  e('div', { className: 'admin-io-row', key: 'actions' }, [
                    e('button', {
                      key: 'toggle',
                      type: 'button',
                      className: 'admin-io-btn',
                      'aria-expanded': warningsOpen,
                      'aria-controls': 'warnings-list',
                      onClick: () => setWarningsOpen((prev) => !prev),
                    }, warningsOpen ? 'Hide Issues' : `View Issues (${integrityWarnings.length})`),
                    e(
                      'button',
                      { key: 'autofix', type: 'button', className: 'admin-io-btn', onClick: handleAutoFix },
                      'Auto-Fix'
                    ),
                  ]),
                integrityWarnings.length > 0 &&
                  warningsOpen &&
                  e(
                    'ul',
                    { className: 'admin-warnings', id: 'warnings-list', key: 'warnings-list' },
                    integrityWarnings.map((warning, i) => e('li', { key: `warning-${i}` }, warning))
                  ),
                adminMessage &&
                  e('p', { className: 'admin-message', role: 'status', key: 'integrity-message' }, adminMessage),
              ]),
            ]),
        ]
      ),

    // Temporarily hidden — not deleted, since this may come back.
    false &&
      e('p', { className: 'beta-notice', key: 'beta-notice' }, [
        e('strong', { key: 'lead' }, 'Heads up — we’re still building this thing. '),
        'You might see rough edges, missing features, or occasional weirdness while we continue shaping the full experience. Everything you see is part of an evolving work in progress.',
      ]),

    e(
      'p',
      // The stats fallback stays on one line no matter how long the numbers
      // get; a custom typed message is free to wrap across multiple lines
      // same as before — only the default gets the nowrap treatment.
      { className: motd ? 'motd-banner' : 'motd-banner motd-banner--default', role: 'status', key: 'motd-banner' },
      motd || defaultMotd(users, checkins, weights)
    ),

    e('div', { className: 'sections', key: 'sections' }, [
    e('section', { className: 'section checkin-section', key: 'checkin-section' }, [
      e('form', { className: 'form', key: 'form', onSubmit: handleCheckin }, [
        e('div', { className: 'checkin-input-wrap', key: 'input-wrap' }, [
          e('input', {
            key: 'input',
            id: 'checkin-username',
            type: 'text',
            'aria-label': 'Enter username to check in...',
            value: checkinUsername,
            disabled: !inEventMode && !debugBypassGates && !checkinOpen,
            onChange: (evt) => setCheckinUsername(evt.target.value),
          }),
          // A native `placeholder` can't include an animated cursor, so this
          // stands in for it — same look, just with a blinking "|" to draw
          // the eye. Hidden as soon as there's a value, same as a real one.
          checkinUsername === '' &&
            e('span', { className: 'checkin-placeholder', key: 'placeholder', 'aria-hidden': 'true' }, [
              'Enter username to check in...',
              e('span', { className: 'checkin-cursor', key: 'cursor' }, '|'),
            ]),
        ]),
        e('button', { key: 'submit', type: 'submit', disabled: !inEventMode && !debugBypassGates && !checkinOpen }, 'Check In'),
      ]),
      checkinMessage && e('p', { className: 'message', role: 'status', key: 'message' }, checkinMessage),
    ]),

    e('section', { className: `section registration-section${registrationOpen ? '' : ' collapsed'}`, key: 'register-section' }, [
      e('h2', { className: 'section-heading', key: 'h2' }, [
        e(
          'button',
          {
            key: 'toggle',
            type: 'button',
            className: 'section-toggle',
            'aria-expanded': registrationOpen,
            'aria-controls': 'registration-panel',
            onClick: () => setRegistrationOpen((prev) => !prev),
          },
          [
            e('span', { key: 'label' }, inEventMode ? 'Visitor Check-In' : 'New User Registration'),
            e(
              'span',
              { className: 'section-toggle-icon', key: 'icon', 'aria-hidden': 'true' },
              registrationOpen ? '−' : '+'
            ),
          ]
        ),
      ]),

      registrationOpen &&
      e('div', { id: 'registration-panel', key: 'registration-panel' }, [
      e('form', { className: 'form', key: 'form', onSubmit: inEventMode ? handleVisitorCheckin : handleRegister }, [
        // Visitor Check-In (event mode) skips username entirely — visitors
        // are logged separately from users, by email/phone only.
        !inEventMode &&
          e('label', { key: 'username-label', htmlFor: 'reg-username' }, 'Username'),
        !inEventMode &&
          e('input', {
            key: 'username-input',
            id: 'reg-username',
            type: 'text',
            maxLength: USERNAME_MAX_LENGTH,
            value: form.username,
            'aria-invalid': formErrors.username ? 'true' : undefined,
            'aria-describedby': formErrors.username ? 'error-username' : undefined,
            onChange: (evt) => handleFormFieldChange('username', evt.target.value),
          }),
        !inEventMode && formErrors.username &&
          e('p', { className: 'error', id: 'error-username', role: 'alert', key: 'username-error' }, formErrors.username),

        e('label', { key: 'email-label', htmlFor: 'reg-email' }, 'Email'),
        e('input', {
          key: 'email-input',
          id: 'reg-email',
          type: 'text',
          value: form.email,
          'aria-invalid': formErrors.email ? 'true' : undefined,
          'aria-describedby': formErrors.email ? 'error-email' : undefined,
          onChange: (evt) => handleFormFieldChange('email', evt.target.value),
        }),
        formErrors.email &&
          e('p', { className: 'error', id: 'error-email', role: 'alert', key: 'email-error' }, formErrors.email),

        e('label', { key: 'phone-label', htmlFor: 'reg-phone' }, 'Phone'),
        e('input', {
          key: 'phone-input',
          id: 'reg-phone',
          type: 'text',
          value: form.phone,
          'aria-invalid': formErrors.phone ? 'true' : undefined,
          'aria-describedby': formErrors.phone ? 'error-phone' : undefined,
          onChange: (evt) => handleFormFieldChange('phone', evt.target.value),
        }),
        formErrors.phone &&
          e('p', { className: 'error', id: 'error-phone', role: 'alert', key: 'phone-error' }, formErrors.phone),

        // Event-mode registration is intentionally shorter — no ZIP, no
        // curbside interest, just the essentials plus the opt-ins below.
        !inEventMode &&
          e('label', { key: 'zip-label', htmlFor: 'reg-zip' }, 'ZIP Code'),
        !inEventMode &&
          e('input', {
            key: 'zip-input',
            id: 'reg-zip',
            type: 'text',
            value: form.zip,
            'aria-invalid': formErrors.zip ? 'true' : undefined,
            'aria-describedby': formErrors.zip ? 'error-zip' : undefined,
            onChange: (evt) => handleFormFieldChange('zip', evt.target.value),
          }),
        !inEventMode && formErrors.zip &&
          e('p', { className: 'error', id: 'error-zip', role: 'alert', key: 'zip-error' }, formErrors.zip),

        !inEventMode &&
        e(
          'label',
          { className: 'checkbox-label checkbox-label--compact', htmlFor: 'reg-curbside', key: 'curbside-label' },
          [
            e('input', {
              key: 'curbside-input',
              id: 'reg-curbside',
              type: 'checkbox',
              checked: form.curbsideInterest,
              onChange: (evt) => handleFormFieldChange('curbsideInterest', evt.target.checked),
            }),
            'Interested in curbside recycling? ',
            e('span', { className: 'checkbox-optional', key: 'curbside-tag' }, '(optional)'),
          ]
        ),

        // Distinct from curbsideInterest above — that's "would you want it,"
        // this is "do you currently have no option at all" (e.g. an
        // apartment/multi-unit building). The building-name follow-up only
        // appears once this is checked, since it's meaningless otherwise.
        !inEventMode &&
        e(
          'label',
          { className: 'checkbox-label checkbox-label--compact', htmlFor: 'reg-no-curbside', key: 'no-curbside-label' },
          [
            e('input', {
              key: 'no-curbside-input',
              id: 'reg-no-curbside',
              type: 'checkbox',
              checked: form.noCurbsideAccess,
              onChange: (evt) => handleFormFieldChange('noCurbsideAccess', evt.target.checked),
            }),
            'No curbside recycling where I live (e.g. an apartment)? ',
            e('span', { className: 'checkbox-optional', key: 'no-curbside-tag' }, '(optional)'),
          ]
        ),
        !inEventMode && form.noCurbsideAccess &&
          e('label', { key: 'building-name-label', htmlFor: 'reg-building-name' }, 'Building or property name (optional)'),
        !inEventMode && form.noCurbsideAccess &&
          e('input', {
            key: 'building-name-input',
            id: 'reg-building-name',
            type: 'text',
            maxLength: BUILDING_NAME_MAX_LENGTH,
            value: form.buildingName,
            'aria-invalid': formErrors.buildingName ? 'true' : undefined,
            'aria-describedby': formErrors.buildingName ? 'error-building-name' : undefined,
            onChange: (evt) => handleFormFieldChange('buildingName', evt.target.value),
          }),
        !inEventMode && form.noCurbsideAccess && formErrors.buildingName &&
          e('p', { className: 'error', id: 'error-building-name', role: 'alert', key: 'building-name-error' }, formErrors.buildingName),

        // Visitor Check-In collects only email + phone, per spec — no opt-in
        // checkbox in that mode either.
        // One checkbox drives both smsOptIn and emailOptIn — kept as two
        // separate stored fields (unchanged export/analytics shape, and
        // room to re-split the choice later) even though the form only
        // ever sets them together now.
        !inEventMode &&
        e(
          'label',
          { className: 'checkbox-label checkbox-label--compact', htmlFor: 'reg-updates-optin', key: 'updates-optin-label' },
          [
            e('input', {
              key: 'updates-optin-input',
              id: 'reg-updates-optin',
              type: 'checkbox',
              checked: form.smsOptIn,
              onChange: (evt) => {
                const checked = evt.target.checked;
                setForm((prev) => ({ ...prev, smsOptIn: checked, emailOptIn: checked }));
              },
            }),
            'OK to send text/email updates? ',
            e('span', { className: 'checkbox-optional', key: 'updates-optin-tag' }, '(optional)'),
          ]
        ),

        e('button', { key: 'submit', type: 'submit' }, inEventMode ? 'Check In' : 'Register'),
      ]),
      registerMessage && e('p', { className: 'message', role: 'status', key: 'message' }, registerMessage),
      // Covers the no-technician case: if nobody's driving the card reader
      // for them, they should at least know to ask for a card on a later
      // visit. A brief heads-up (see cardReminderVisible above), not
      // something that lingers waiting for the card flow to resolve.
      cardReminderVisible &&
        e(
          'p',
          { className: 'card-program-reminder', role: 'status', key: 'card-reminder' },
          "Don't forget to ask for your Recycle Heroes! card for quick check-in!"
        ),
      // Fully ambient — no click required to arm it (handleRegister already
      // did that) and nothing to click to dismiss it either. A pulsing dot
      // shows a tap is being listened for; the outcome gets a brief visual
      // beat (a checkmark, or a short notice for a miss/failure) and then
      // fades on its own — see the cardCueFading effects above. There's
      // deliberately no retry/skip button: a missed or failed automatic
      // window is what Card Management (below the form) is for.
      postRegistrationUsername &&
        cardWriteStatus &&
        cardWriteStatus.username === postRegistrationUsername &&
        (cardWriteStatus.state === 'sending' || cardWriteStatus.state === 'armed') &&
        e(
          'div',
          {
            className: `card-cue card-cue--pulse${cardCueFading ? ' card-cue--fading' : ''}`,
            key: 'card-cue-pulse',
            role: 'status',
            'aria-label': 'Activating card — tap now',
          },
          [e('span', { className: 'card-cue-dot', key: 'dot', 'aria-hidden': 'true' })]
        ),
      postRegistrationUsername &&
        cardWriteStatus &&
        cardWriteStatus.username === postRegistrationUsername &&
        cardWriteStatus.state === 'success' &&
        e(
          'div',
          {
            className: `card-cue card-cue--success${cardCueFading ? ' card-cue--fading' : ''}`,
            key: 'card-cue-success',
            role: 'status',
            'aria-label': 'Card activated',
          },
          [e('span', { className: 'card-cue-check', key: 'check', 'aria-hidden': 'true' }, '✓')]
        ),
      postRegistrationUsername &&
        cardWriteStatus &&
        cardWriteStatus.username === postRegistrationUsername &&
        (cardWriteStatus.state === 'error' || cardWriteStatus.state === 'expired') &&
        e(
          'p',
          {
            className: `card-cue card-cue--notice${cardCueFading ? ' card-cue--fading' : ''}`,
            key: 'card-cue-notice',
            role: 'status',
          },
          cardWriteStatus.state === 'expired'
            ? 'No card was tapped.'
            : `Card activation didn't work: ${cardWriteStatus.error || 'unknown error'}`
        ),

        // Deliberately low-key, and nested inside the registration panel
        // itself rather than sitting on screen at all times — it only
        // appears while a staff member already has this panel open (i.e.
        // already in "working with a user" mode), not as a persistent
        // fixture competing with check-in for attention. Staff still need
        // to be able to find this to (re)issue a card outside the
        // registration moment (lost card, first-timer from before this
        // existed, bridge wasn't connected at signup) — just not a visitor
        // stumbling into it out of curiosity.
        e('div', { className: 'card-management-tucked', key: 'card-management-tucked' }, [
          e(
            'button',
            {
              key: 'toggle',
              type: 'button',
              className: 'card-management-toggle',
              'aria-expanded': cardManagementOpen,
              'aria-controls': 'card-management-panel',
              onClick: () => setCardManagementOpen((prev) => !prev),
            },
            cardManagementOpen ? '− Card Management' : '+ Card Management'
          ),
          cardManagementOpen &&
            e('div', { id: 'card-management-panel', key: 'card-management-panel', className: 'admin-cards-section' }, [
              e(
                'p',
                { className: rfidBridgeConnected ? 'admin-cards-status-ok' : 'admin-cards-status-off', key: 'status' },
                rfidBridgeConnected
                  ? '🟢 Card reader connected'
                  : '⚪ Card reader not connected — start the bridge program on this computer to enable card writing.'
              ),
              e('form', { className: 'admin-cards-form', key: 'form', onSubmit: handleStartCardManagementWrite }, [
                e('label', { htmlFor: 'card-management-username', key: 'label' }, 'Username to program a card for'),
                e('div', { className: 'admin-weight-row', key: 'row' }, [
                  e('input', {
                    key: 'input',
                    id: 'card-management-username',
                    type: 'text',
                    value: cardManagementUsername,
                    onChange: (evt) => {
                      setCardManagementUsername(evt.target.value);
                      setCardManagementError('');
                    },
                  }),
                  e(
                    'button',
                    { key: 'submit', type: 'submit', className: 'admin-io-btn', disabled: !rfidBridgeConnected },
                    'Program Card'
                  ),
                ]),
                cardManagementError && e('p', { className: 'error', key: 'error' }, cardManagementError),
              ]),
              cardWriteStatus &&
                cardWriteStatus.username &&
                cardWriteStatus.username.toLowerCase() === cardManagementUsername.trim().toLowerCase() &&
                e('div', { className: 'card-program-prompt', key: 'status-block' }, [
                  cardWriteStatus.state === 'sending' &&
                    e('p', { className: 'card-program-note', key: 'sending' }, 'Arming the card reader...'),
                  cardWriteStatus.state === 'armed' &&
                    e(
                      'p',
                      { className: 'card-program-armed', key: 'armed' },
                      `Tap a blank card on the reader now... (${cardWriteSecondsLeft ?? WRITE_WINDOW_SECONDS}s)`
                    ),
                  cardWriteStatus.state === 'expired' &&
                    e(
                      'p',
                      { className: 'card-program-error', key: 'expired' },
                      "Time's up — no card was tapped. Submit the form above to try again."
                    ),
                  cardWriteStatus.state === 'success' &&
                    e('p', { className: 'card-program-success', key: 'success' }, `Card activated for "${cardWriteStatus.username}".`),
                  cardWriteStatus.state === 'error' &&
                    e(
                      'p',
                      { className: 'card-program-error', key: 'error' },
                      `Card activation didn't work: ${cardWriteStatus.error || 'unknown error'}`
                    ),
                ]),
            ]),
        ]),
      ]),
    ]),
    ]),

    e(
      'p',
      { className: 'app-footer', key: 'app-footer' },
      'Developed by Nexus Microsolutions in partnership with Recycle Here!'
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Future feature placeholders (not implemented — hooks for later work only)
// ---------------------------------------------------------------------------

// Partnership-driven service recommendations based on a user's ZIP/interest.
// function getPartnershipRecommendations(user) { /* look up local partners */ }

// Additional data fields to consider adding to the data model later:
// householdSize, preferredPickupDay, referralSource, notes

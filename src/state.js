/*
 * state.js — État : conversations WhatsApp, pauses, anti-doublons, persistance dans un fichier JSON
 * (extrait de l'ancien server.js ; voir server.js pour l'architecture)
 */

const fs = require('fs');
const path = require('path');

// ==================== MÉMOIRE DES CONVERSATIONS (WhatsApp) ====================

const MEMORY_MAX_MESSAGES = 10; // 5 échanges (question + réponse)
const MEMORY_TTL_MS = 24 * 60 * 60 * 1000; // 24 h, comme la fenêtre WhatsApp (messages seulement)
const LOCK_DAYS = Math.max(Number(process.env.LOCK_DAYS) || 90, 1);
const LOCK_MS = LOCK_DAYS * 24 * 3600 * 1000;
// Un voyageur vérifié, un numéro bloqué ou un compteur d'échecs en cours sont gardés bien plus longtemps que les messages
const DURABLE_TTL_MS = (LOCK_DAYS + 10) * 24 * 3600 * 1000;
function isDurableConv(c) { return !!(c && (c.verifiedBookingId || c.locked || c.failedAttempts)); }
function convTtl(c) { return isDurableConv(c) ? DURABLE_TTL_MS : MEMORY_TTL_MS; }
const conversations = new Map(); // numéro -> { messages, updated, verifiedBookingId, linksSent, lastWasCourtesy, identityText, locked, notifyFailAt, failedAttempts }

function ensureConv(phone) {
  let conv = conversations.get(phone);
  if (!conv) {
    conv = { messages: [], updated: Date.now(), verifiedBookingId: null, linksSent: false, lastWasCourtesy: false, identityText: '', locked: false, lockedAt: 0, notifyFailAt: 0, introduced: false, failedAttempts: 0, failedAt: 0 };
    conversations.set(phone, conv);
  } else if (Date.now() - conv.updated > MEMORY_TTL_MS) {
    // Les messages expirent après 24 h, mais la vérification, le blocage et le compteur d'échecs sont conservés
    // (la réservation reste revérifiée à chaque message : elle doit toujours être en cours de séjour)
    conv.messages = []; conv.identityText = ''; conv.linksSent = false; conv.lastWasCourtesy = false; conv.notifyFailAt = 0;
    conv.updated = Date.now();
  }
  return conv;
}

// Numéro bloqué ? Le blocage tombe seulement après LOCK_DAYS (ou par /valider, /debloquer)
function isLocked(conv) {
  if (!conv || !conv.locked) return false;
  if (Date.now() - (conv.lockedAt || 0) > LOCK_MS) {
    conv.locked = false; conv.lockedAt = 0; conv.failedAttempts = 0; conv.failedAt = 0;
    markDirty();
    return false;
  }
  return true;
}
function lockConv(conv) { conv.locked = true; conv.lockedAt = Date.now(); markDirty(); }

function getHistory(phone) {
  const conv = conversations.get(phone);
  if (!conv || Date.now() - conv.updated > MEMORY_TTL_MS) return []; // pas de suppression : la vérification est conservée
  return conv.messages.slice();
}

function addToHistory(phone, userText, assistantText) {
  const conv = ensureConv(phone);
  conv.messages.push({ role: 'user', content: String(userText).substring(0, 1500) });
  conv.messages.push({ role: 'assistant', content: String(assistantText).substring(0, 1500) });
  while (conv.messages.length > MEMORY_MAX_MESSAGES) conv.messages.shift();
  // L'historique doit toujours commencer par un message du voyageur
  while (conv.messages.length && conv.messages[0].role !== 'user') conv.messages.shift();
  if (/locations-residence-industrie\.fr|airbnb\.com\/h\/|booking\.com\/Share/i.test(assistantText)) conv.linksSent = true;
  conv.updated = Date.now();
}

// Pause du bot (le propriétaire reprend la main)
const pauses = new Map(); // numéro WhatsApp ou "b<id réservation>" -> timestamp de fin
function pauseConversation(key, hours) { pauses.set(key, Date.now() + hours * 3600 * 1000); markDirty(); }
function resumeConversation(key) { pauses.delete(key); markDirty(); }
function isPaused(key) {
  const until = pauses.get(key);
  if (!until) return false;
  if (Date.now() > until) { pauses.delete(key); return false; }
  return true;
}

// Doublons de webhook (Meta renvoie un message si on répond trop lentement)
const seenWaIds = new Map();
function alreadySeen(id) {
  if (!id) return false;
  if (seenWaIds.has(id)) return true;
  seenWaIds.set(id, Date.now());
  return false;
}

// File d'attente par expéditeur : deux messages rapprochés ne se mélangent pas
const chains = new Map();
function runSerial(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(key, next);
  next.finally(() => { if (chains.get(key) === next) chains.delete(key); });
  return next;
}

// Beds24 : dernière réponse de politesse par réservation (évite de répéter "avec plaisir")
const COURTESY_WINDOW_MS = 6 * 60 * 60 * 1000;
const courtesyAt = new Map();
const introducedBookings = new Map(); // réservations Beds24 où le bot s'est déjà présenté (id → date)

// ==================== PERSISTANCE (survit aux redémarrages) ====================
// Un petit fichier JSON garde : les pauses, les vérifications d'identité, les alertes déjà envoyées et les présentations déjà faites.
// Aucun texte de message ni identité de voyageur n'y est écrit (uniquement des numéros, des ID de réservation et des dates).
// Sur Render, le fichier ne survit à un redémarrage que sur un disque persistant (voir STATE_FILE).

const STATE_FILE = process.env.STATE_FILE || (fs.existsSync('/var/data') ? '/var/data/state.json' : path.join(__dirname, '..', 'state.json'));
let persistenceOn = false;
let saveTimer = null;

function markDirty() {
  if (!persistenceOn || saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveState(); }, 1500);
  if (saveTimer.unref) saveTimer.unref();
}

function snapshotState(now = Date.now()) {
  const convs = {};
  for (const [phone, c] of conversations) {
    if (now - c.updated > convTtl(c)) continue;
    if (!c.verifiedBookingId && !c.locked && !c.failedAttempts && !c.introduced && !c.verifyAlertSent) continue;
    convs[phone] = {
      updated: c.updated, verifiedBookingId: c.verifiedBookingId || null, verifiedReasons: c.verifiedReasons || [],
      locked: !!c.locked, lockedAt: c.lockedAt || 0, failedAttempts: c.failedAttempts || 0, failedAt: c.failedAt || 0, introduced: !!c.introduced,
      linksSent: !!c.linksSent, verifyAlertSent: !!c.verifyAlertSent
    };
  }
  return {
    version: 1, savedAt: now,
    pauses: Object.fromEntries([...pauses].filter(([, until]) => until > now)),
    seenBookingEvents: Object.fromEntries(seenBookingEvents),
    introducedBookings: Object.fromEntries(introducedBookings),
    seenWaIds: Object.fromEntries([...seenWaIds].filter(([, t]) => now - t < 6 * 3600 * 1000)),
    conversations: convs
  };
}

function restoreState(data, now = Date.now()) {
  if (!data || typeof data !== 'object') return;
  for (const [k, until] of Object.entries(data.pauses || {})) if (Number(until) > now) pauses.set(k, Number(until));
  for (const [k, t] of Object.entries(data.seenBookingEvents || {})) seenBookingEvents.set(k, Number(t) || now);
  for (const [k, t] of Object.entries(data.introducedBookings || {})) introducedBookings.set(k, Number(t) || now);
  for (const [id, t] of Object.entries(data.seenWaIds || {})) if (now - Number(t) < 6 * 3600 * 1000) seenWaIds.set(id, Number(t));
  for (const [phone, c] of Object.entries(data.conversations || {})) {
    if (!c) continue;
    const durable = !!(c.verifiedBookingId || c.locked || Number(c.failedAttempts));
    if (now - Number(c.updated) > (durable ? DURABLE_TTL_MS : MEMORY_TTL_MS)) continue;
    conversations.set(phone, {
      messages: [], updated: Number(c.updated), verifiedBookingId: c.verifiedBookingId || null, verifiedReasons: c.verifiedReasons || [],
      linksSent: !!c.linksSent, lastWasCourtesy: false, identityText: '', locked: !!c.locked, lockedAt: Number(c.lockedAt) || (c.locked ? Number(c.updated) : 0), notifyFailAt: 0,
      introduced: !!c.introduced, failedAttempts: Number(c.failedAttempts) || 0, failedAt: Number(c.failedAt) || 0, verifyAlertSent: !!c.verifyAlertSent
    });
  }
}

function saveState() {
  if (!persistenceOn) return;
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshotState()));
    fs.renameSync(tmp, STATE_FILE); // écriture atomique : jamais de fichier à moitié écrit
  } catch (err) {
    console.error('Erreur sauvegarde état:', err.message);
  }
}

// Vrai tant que le premier passage de surveillance des réservations n'a pas été fait sans état rechargé (voir checkNewBookings)
const runtime = { bookingBaselinePending: false }; // partagé avec la surveillance des réservations
const BASELINE_GRACE_MS = 30 * 60 * 1000;
const PERSISTENT_DISK = !!process.env.STATE_FILE || STATE_FILE.startsWith('/var/data');

function loadState() {
  let restored = false;
  if (!PERSISTENT_DISK) console.warn('⚠️ Pas de disque persistant : pauses, vérifications, blocages et alertes déjà envoyées seront perdus à chaque redémarrage. Ajoutez un disque Render monté sur /var/data (ou définissez STATE_FILE).');
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    if (fs.existsSync(STATE_FILE)) {
      restoreState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
      restored = true;
      console.log(`💾 État rechargé (${STATE_FILE}) : ${pauses.size} pause(s), ${seenBookingEvents.size} alerte(s) déjà envoyée(s), ${conversations.size} conversation(s) vérifiée(s)`);
    } else {
      console.log(`💾 Aucun état sauvegardé (${STATE_FILE}) : première utilisation ou disque non persistant`);
    }
    fs.writeFileSync(STATE_FILE + '.tmp', '{}'); // vérifie que le dossier est bien inscriptible
    fs.unlinkSync(STATE_FILE + '.tmp');
    persistenceOn = true;
  } catch (err) {
    console.error('⚠️ Persistance désactivée (', STATE_FILE, ') :', err.message);
  }
  // Sans état rechargé, le bot ne sait plus quelles demandes il a déjà signalées : au premier passage, les réservations
  // modifiées il y a plus de 30 min avant le démarrage sont considérées comme déjà signalées (pas d'alertes en double)
  runtime.bookingBaselinePending = !restored;
}

// Alertes déjà envoyées : "idRéservation:type" → date (conservé dans le fichier d'état)
const seenBookingEvents = new Map();

function isPersistenceOn() { return persistenceOn; }

module.exports = {
  MEMORY_MAX_MESSAGES,
  MEMORY_TTL_MS,
  LOCK_DAYS,
  LOCK_MS,
  DURABLE_TTL_MS,
  isDurableConv,
  convTtl,
  conversations,
  ensureConv,
  isLocked,
  lockConv,
  getHistory,
  addToHistory,
  pauses,
  pauseConversation,
  resumeConversation,
  isPaused,
  seenWaIds,
  alreadySeen,
  chains,
  runSerial,
  COURTESY_WINDOW_MS,
  courtesyAt,
  introducedBookings,
  STATE_FILE,
  markDirty,
  snapshotState,
  restoreState,
  saveState,
  runtime,
  BASELINE_GRACE_MS,
  PERSISTENT_DISK,
  loadState,
  seenBookingEvents,
  isPersistenceOn
};

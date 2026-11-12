/*
 * utils.js — Utilitaires purs : dates, textes, téléphones, fetch avec délai, logs sans données personnelles
 * (extrait de l'ancien server.js ; voir server.js pour l'architecture)
 */

const crypto = require('crypto');
const { LOG_CONTENT } = require('./config');

function fill(text, key, value) { return text.split(key).join(value); }

function getDatetime() {
  return new Date().toLocaleString('fr-FR', {
    timeZone: 'Europe/Paris',
    weekday: 'long', year: 'numeric', month: 'long',
    day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function parisToday() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }); // AAAA-MM-JJ
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function calendarHint(days = 21) {
  const today = parisToday();
  const lines = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(today, i);
    const label = new Date(d + 'T12:00:00Z').toLocaleDateString('fr-FR', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
    });
    lines.push(`- ${label} = ${d}${i === 0 ? " (aujourd'hui)" : ''}`);
  }
  return lines.join('\n');
}

function normalizeText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function tokens(s) {
  return normalizeText(s).split(/[^a-z0-9]+/).filter(t => t.length >= 2);
}

// Particules de noms ("El Amrani", "Ben Ali", "de la Tour") : le voyageur ne les écrit pas toujours
const NAME_PARTICLES = new Set(['de', 'du', 'la', 'le', 'les', 'el', 'al', 'ben', 'bin', 'van', 'von', 'des', 'da', 'di', 'dos', 'ait']);
function significantTokens(list) {
  const s = list.filter(t => !NAME_PARTICLES.has(t));
  return s.length ? s : list;
}

// Clé de comparaison de téléphone : 9 derniers chiffres (indépendant de +33 / 0 / 0033)
function phoneKey(p) {
  const digits = String(p || '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : '';
}

// Clés de comparaison des deux champs téléphone d'une réservation Beds24 (mobile et phone)
function bookingPhoneKeys(b) {
  return [b?.mobile, b?.phone].map(phoneKey).filter(Boolean);
}

// Numéro au format WhatsApp : indicatif pays, sans + ni espaces
function normalizeWaNumber(s) {
  let n = String(s || '').replace(/\D/g, '');
  if (n.startsWith('00')) n = n.slice(2);
  if (n.length === 10 && n.startsWith('0')) n = '33' + n.slice(1);
  return n;
}

let fetchPromise = null;
function getFetch() {
  if (!fetchPromise) fetchPromise = import('node-fetch').then(m => m.default);
  return fetchPromise;
}

// fetch avec délai maximum, pour ne jamais bloquer le serveur
async function fetchT(url, options = {}, ms = 15000) {
  const fetch = await getFetch();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Logs sans données personnelles : longueur du texte seulement (LOG_CONTENT=on pour le texte, pendant un débogage)
function logText(s, n = 80) {
  const t = String(s || '');
  return LOG_CONTENT ? t.substring(0, n) : `[${t.length} car.]`;
}
function logName(b) {
  if (!b) return 'introuvable';
  if (LOG_CONTENT) return `${b.firstName || ''} ${b.lastName || ''}`.trim();
  return [b.firstName, b.lastName].filter(Boolean).map(x => String(x)[0].toUpperCase() + '.').join(' ') || '?';
}

// Retire d'un message d'erreur tout jeton de bot Telegram (node-fetch recopie l'URL complète dans ses erreurs réseau)
function scrub(s) {
  return String(s ?? '').replace(/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, 'bot[masqué]');
}

module.exports = {
  fill,
  getDatetime,
  parisToday,
  addDays,
  calendarHint,
  normalizeText,
  tokens,
  NAME_PARTICLES,
  significantTokens,
  phoneKey,
  bookingPhoneKeys,
  normalizeWaNumber,
  getFetch,
  fetchT,
  safeEqual,
  logText,
  logName,
  scrub
};

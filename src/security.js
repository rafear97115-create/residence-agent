/*
 * security.js — Sécurité : clé admin, signature Meta, limites de débit, filtre d'adresse
 * (extrait de l'ancien server.js ; voir server.js pour l'architecture)
 */

const crypto = require('crypto');
const { ADMIN_KEY_QUERY, ALLOW_UNSIGNED_WEBHOOKS } = require('./config');
const { safeEqual } = require('./utils');

// ==================== SÉCURITÉ ====================

function requireAdmin(req, res, next) {
  const key = process.env.ADMIN_KEY;
  if (!key) return res.status(403).json({ error: 'Route désactivée : définissez ADMIN_KEY sur Render.' });
  const provided = req.get('x-admin-key') || (ADMIN_KEY_QUERY ? req.query.key : '') || '';
  if (!provided || !safeEqual(provided, key)) return res.sendStatus(403);
  next();
}

function verifyMetaSignature(req) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) {
    // Sans secret, n'importe qui pourrait forger un webhook (et se faire passer pour le propriétaire : /valider, /pause...)
    if (!ALLOW_UNSIGNED_WEBHOOKS) console.error('⛔ WHATSAPP_APP_SECRET non défini : webhook refusé');
    return ALLOW_UNSIGNED_WEBHOOKS;
  }
  if (!req.rawBody) return false;
  const sig = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  return safeEqual(sig, expected);
}

const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { rateBuckets.set(key, arr); return false; }
  arr.push(now);
  rateBuckets.set(key, arr);
  return true;
}

// ==================== ADRESSE : filet de sécurité ====================
// Même si le modèle se trompe, l'adresse exacte est retirée des réponses qui ne doivent pas la contenir.


// ==================== ADRESSE : filet de sécurité ====================
// Même si le modèle se trompe, l'adresse exacte est retirée des réponses qui ne doivent pas la contenir.
// Durci : apostrophes de toutes sortes (ou absentes), "l industrie", "lindustrie", "r.", "n°11", "numéro 11", "11 bis",
// "st quentin", code postal avec espace, version anglaise, caractères invisibles et espaces insécables.
const ADDR_APOS = "['\u2019\u2018`\u00B4\u2032\u02BC]";
const ADDRESS_RE = new RegExp(
  '(?:' +
    '(?:\\bau\\s+)?' +
    '(?:(?:n\\s?\u00B0|no\\b\\.?|num(?:\u00E9|e)ro)\\s*)?' +
    '(?:\\b11\\s*(?:bis\\b\\s*)?,?\\s*(?:de\\s+la\\s+)?)?' +
    '\\b(?:rue|r\\.?|ru)\\s+de\\s+l' + ADDR_APOS + '?\\s*industrie\\b' +
    '(?:\\s*,?\\s*0?2\\s?100(?:\\s*[-,]?\\s*(?:saint|st)[\\s.-]*quentin)?|\\s*,?\\s*(?:saint|st)[\\s.-]*quentin)?' +
  ')|(?:' +
    '(?:\\b11\\s+)?\\bindustry\\s+(?:street|st\\b\\.?)(?:\\s*,?\\s*(?:0?2\\s?100|(?:saint|st)[\\s.-]*quentin))?' +
  ')',
  'gi'
);

function applyAddressPolicy(reply, allowAddress) {
  if (allowAddress) return reply;
  const cleaned = String(reply || '').replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, ''); // caractères invisibles glissés dans l'adresse
  return cleaned.replace(ADDRESS_RE, m => (/^au\s/i.test(m) ? '\u00E0 ' : '') + 'Saint-Quentin (02100)');
}

// Compteurs de limite sans incrément automatique (échecs de vérification)
function limitReached(key, max, windowMs) {
  const now = Date.now();
  return (rateBuckets.get(key) || []).filter(t => now - t < windowMs).length >= max;
}
function recordHit(key, windowMs) {
  const now = Date.now();
  const arr = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  rateBuckets.set(key, arr);
}

module.exports = {
  requireAdmin,
  verifyMetaSignature,
  rateBuckets,
  rateLimit,
  ADDR_APOS,
  ADDRESS_RE,
  applyAddressPolicy,
  limitReached,
  recordHit
};

/*
 * identity.js — Vérification d'identité des voyageurs (chat web et WhatsApp), anti-devinette
 * (extrait de l'ancien server.js ; voir server.js pour l'architecture)
 */

const { getAllActiveBookings, getBookingById, getPropertyInfo, isActiveStay } = require('./beds24');
const { MAX_BAD_EMAILS, MAX_DAY_NUMBERS, MAX_FAILED_ATTEMPTS, MAX_UNITS_MENTIONED, STAY_VERIFICATION, applyEmailRequirement } = require('./config');
const { AIRBNB_LINKS, buildRoomNumbers } = require('./rooms');
const { ensureConv, isLocked, lockConv, markDirty } = require('./state');
const { bookingPhoneKeys, normalizeText, phoneKey, significantTokens, tokens } = require('./utils');

// ---------- Vérification d'identité ----------
// Règle : 2 critères sur 4 (nom, téléphone, email, séjour), comparaison EXACTE (plus de sous-chaînes).
// Le critère "séjour" (WhatsApp seulement) = dates exactes d'arrivée et de départ + numéro du logement.
// NB : pour une réservation Airbnb/Booking, l'email stocké dans Beds24 est une adresse relais que le voyageur
// ne connaît pas, et le téléphone est souvent absent : sans critère "séjour", ces voyageurs ne peuvent pas être vérifiés.

function lastNameTokens(b) {
  const ln = significantTokens(tokens(b.lastName));
  return ln.length ? ln : significantTokens(tokens(b.firstName));
}

// Chat web : l'utilisateur fournit nom / téléphone / email
function webIdentityScore(b, provided) {
  let score = 0;
  const reasons = [];

  if (provided.name) {
    const p = tokens(provided.name);
    const bookingTokens = new Set([...tokens(b.firstName), ...tokens(b.lastName)]);
    const lt = lastNameTokens(b);
    if (p.length && p.every(t => bookingTokens.has(t)) && lt.some(t => p.includes(t))) {
      score++; reasons.push('nom');
    }
  }
  if (provided.phone) {
    const pk = phoneKey(provided.phone);
    if (pk && bookingPhoneKeys(b).includes(pk)) { score++; reasons.push('téléphone'); }
  }
  if (provided.email && b.email) {
    if (String(provided.email).toLowerCase().trim() === String(b.email).toLowerCase().trim()) {
      score++; reasons.push('email');
    }
  }
  return applyEmailRequirement(b, { score, reasons });
}

async function verifyGuestIdentity(provided) {
  const criteria = [provided.name, provided.phone, provided.email].filter(Boolean).length;
  if (criteria < 2) return null; // au moins 2 informations fournies
  const bookings = await getAllActiveBookings();
  let best = null;
  for (const b of bookings) {
    const { score, reasons } = webIdentityScore(b, provided);
    if (score >= 2 && (!best || score > best.score)) best = { b, score, reasons };
  }
  if (best) {
    console.log(`✅ Voyageur vérifié (web) | critères: ${best.reasons.join(', ')} | logement: ${best.b.roomId}`);
    return best.b;
  }
  console.log('❌ Vérification web échouée');
  return null;
}

// WhatsApp : le numéro expéditeur est authentique (Meta), le reste vient de la conversation
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_RE = /(?:\+|00)?\d[\d .-]{7,}\d/g;

// Dates "du 9 au 12" / "9/11 au 12/11" / "du 9 au 12 novembre" : jour d'arrivée puis jour de départ de la réservation.
// Si le voyageur donne un mois (en chiffres ou en lettres), il doit correspondre ; sans mois, seuls les jours comptent.
const MONTH_NAMES = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];
function monthIn(str) {
  const t = String(str || '');
  for (let i = 0; i < 12; i++) if (new RegExp(`\\b${MONTH_NAMES[i]}\\b`).test(t)) return i + 1;
  return null;
}
function stayDatesMatch(b, normText) {
  const a = String(b?.arrival || '');
  const d = String(b?.departure || '');
  const a2 = a.slice(8, 10);
  const d2 = d.slice(8, 10);
  if (a2.length !== 2 || d2.length !== 2) return false;
  const da = String(parseInt(a2, 10));
  const dd = String(parseInt(d2, 10));
  if (da === 'NaN' || dd === 'NaN') return false;
  const am = parseInt(a.slice(5, 7), 10);
  const dm = parseInt(d.slice(5, 7), 10);
  const text = String(normText || '');
  const re = new RegExp(`(?<!\\d)0?${da}(?!\\d)(?:[\\/.\\-](\\d{1,2}))?(?:[\\/.\\-]\\d{2,4})?([^\\d]{1,30}?)(?<!\\d)0?${dd}(?!\\d)(?:[\\/.\\-](\\d{1,2}))?(?:[\\/.\\-]\\d{2,4})?`, 'g');
  for (const m of text.matchAll(re)) {
    const end = m.index + m[0].length;
    const arrMonth = m[1] ? Number(m[1]) : monthIn(m[2]);
    const depMonth = m[3] ? Number(m[3]) : monthIn(text.slice(end, end + 15));
    if (arrMonth && am && arrMonth !== am) continue;
    if (depMonth && dm && depMonth !== dm) continue;
    return true;
  }
  return false;
}

// Numéros de logement cités ("logement 1", "appartement 3", "Agate"...)
function extractUnits(normText) {
  const s = new Set();
  const t = String(normText || '');
  for (const m of t.matchAll(/(?:logement|appartement|appart|studio|chambre)\s*(?:n°|no|numero|num)?\s*([1-5])(?!\d)/g)) s.add(Number(m[1]));
  for (const l of AIRBNB_LINKS) if (l.mots.some(w => t.includes(w))) s.add(l.num);
  return s;
}

function waNameMatches(b, words) {
  const base = lastNameTokens(b);
  return base.length > 0 && base.every(t => words.has(t));
}

function waIdentityScore(b, ctx) {
  let score = 0;
  const reasons = [];
  // Seul le numéro WhatsApp de l'expéditeur (authentifié par Meta) compte comme "téléphone" : un numéro simplement
  // écrit dans le message n'est pas une preuve (le nom et le téléphone d'un voyageur ne sont pas des secrets).
  if (ctx.fromKey && bookingPhoneKeys(b).includes(ctx.fromKey)) { score++; reasons.push('téléphone'); }
  if (b.email && (ctx.emails || []).includes(String(b.email).toLowerCase().trim())) { score++; reasons.push('email'); }
  if (waNameMatches(b, ctx.words)) { score++; reasons.push('nom'); }
  if (STAY_VERIFICATION && !ctx.sprayed && ctx.text && ctx.units && stayDatesMatch(b, ctx.text)) {
    // Si on connaît le numéro de ce logement, le voyageur doit citer le bon.
    // Sinon (nom Beds24 du type "Charmant studio...", sans "Agate"), il doit au moins avoir cité un logement.
    const unit = ctx.roomNumbers ? ctx.roomNumbers.get(String(b.roomId)) : null;
    if (unit ? ctx.units.has(unit) : ctx.units.size > 0) { score++; reasons.push('séjour'); }
  }
  return applyEmailRequirement(b, { score, reasons });
}

// Jours distincts (1 à 31) cités dans un texte, hors numéros de téléphone et emails : une liste de dates sert à deviner
function countDayNumbers(normText) {
  const t = String(normText || '').replace(PHONE_RE, ' ').replace(EMAIL_RE, ' ');
  const days = new Set();
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})(?!\d)/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 31) days.add(n);
  }
  return days.size;
}

// Ce message ressemble-t-il à une tentative d'identification (email, logement, dates) ?
function looksLikeIdentityAttempt(text) {
  const norm = normalizeText(text);
  if ((String(text || '').match(EMAIL_RE) || []).length) return true;
  if (extractUnits(norm).size) return true;
  if (/(?<!\d)\d{1,2}[\/.\-]\d{1,2}(?!\d)/.test(norm)) return true;
  return new RegExp(`(?<!\\d)\\d{1,2}(?!\\d)\\s*(?:${MONTH_NAMES.join('|')}|au\\b)`).test(norm);
}

// Contexte de comparaison construit depuis tout ce que le voyageur a écrit.
// Garde-fou : un texte qui liste beaucoup de logements ou de dates (pour deviner) désactive le critère "séjour".
function buildWaCtx(fromKey, joined, roomNumbers) {
  const norm = normalizeText(joined);
  let units = extractUnits(norm);
  const sprayed = units.size > MAX_UNITS_MENTIONED || countDayNumbers(norm) > MAX_DAY_NUMBERS;
  if (sprayed) units = new Set();
  return {
    fromKey,
    typedPhoneKeys: (String(joined).match(PHONE_RE) || []).map(phoneKey).filter(Boolean),
    emails: (String(joined).match(EMAIL_RE) || []).map(e => e.toLowerCase()),
    words: new Set(norm.split(/[^a-z0-9]+/).filter(Boolean)),
    text: norm,
    units,
    sprayed,
    roomNumbers
  };
}

// Plusieurs voyageurs différents au même meilleur score = le texte les décrit tous (devinette) : on ne valide personne.
function pickBestBooking(scored) {
  if (!scored.length) return { best: null, ambiguous: false };
  const top = Math.max(...scored.map(x => x.score));
  const tied = scored.filter(x => x.score === top);
  const people = new Set(tied.map(x => `${lastNameTokens(x.b).join(' ')}|${x.b.roomId}`));
  if (people.size > 1) return { best: null, ambiguous: true };
  return { best: tied[0], ambiguous: false };
}

// Compte les tentatives d'identification ratées d'un numéro : au-delà de MAX_FAILED_ATTEMPTS, le propriétaire reprend la main
function registerFailedAttempt(conv, text, from, force = false) {
  if (!force && !looksLikeIdentityAttempt(text)) return;
  const now = Date.now();
  if (now - (conv.failedAt || 0) > 24 * 3600 * 1000) conv.failedAttempts = 0; // le compteur retombe après 24 h sans échec (le blocage, lui, dure LOCK_DAYS)
  conv.failedAttempts = (conv.failedAttempts || 0) + 1;
  conv.failedAt = now;
  if (conv.failedAttempts >= MAX_FAILED_ATTEMPTS && !isLocked(conv)) {
    lockConv(conv);
    console.warn('🔒 Vérification WhatsApp bloquée (trop de tentatives) pour ...' + String(from).slice(-3));
  }
  markDirty();
}

async function identifyWhatsAppGuest(from, history, text) {
  try {
    const conv = ensureConv(from);

    // Voyageur déjà vérifié (automatiquement ou par /valider du propriétaire)
    if (conv.verifiedBookingId) {
      let known = (await getAllActiveBookings()).find(x => String(x.id) === String(conv.verifiedBookingId));
      if (!known) {
        const b = await getBookingById(conv.verifiedBookingId);
        if (b && String(b.status || '').toLowerCase() !== 'cancelled' && isActiveStay(b)) known = b;
      }
      if (known) return known;
      conv.verifiedBookingId = null;
      markDirty();
    }
    if (isLocked(conv)) return null;

    const bookings = await getAllActiveBookings();
    if (!bookings.length) return null;
    const propInfo = await getPropertyInfo();

    // Tout ce que le voyageur a écrit depuis le début (l'historique de 10 messages ne suffit pas : il oublie le début)
    const joined = [conv.identityText || '', ...history.filter(m => m.role === 'user').map(m => m.content), text].join(' \n ');
    const ctx = buildWaCtx(phoneKey(from), joined, buildRoomNumbers(propInfo));

    // Anti-devinette : trop d'adresses email qui ne correspondent à aucune réservation => blocage, le propriétaire reprend la main
    const knownEmails = new Set(bookings.map(b => String(b.email || '').toLowerCase().trim()).filter(Boolean));
    const badEmails = new Set(ctx.emails.filter(e => !knownEmails.has(e)));
    if (badEmails.size > MAX_BAD_EMAILS) {
      lockConv(conv);
      markDirty();
      console.warn('🔒 Vérification WhatsApp bloquée (trop d\'emails essayés) pour ...' + String(from).slice(-3));
      return null;
    }

    const scored = [];
    for (const b of bookings) {
      const { score, reasons } = waIdentityScore(b, ctx);
      if (score >= 2) scored.push({ b, score, reasons });
    }
    const { best, ambiguous } = pickBestBooking(scored);
    if (best) {
      conv.verifiedBookingId = best.b.id;
      conv.verifiedReasons = best.reasons;
      markDirty();
      console.log(`✅ Voyageur vérifié (WhatsApp) | critères: ${best.reasons.join(', ')} | logement: ${best.b.roomId}`);
      return best.b;
    }
    if (ambiguous) console.warn('⚠️ Vérification WhatsApp ambiguë (plusieurs voyageurs correspondent) : refusée, ...' + String(from).slice(-3));
    if (ctx.sprayed) console.warn('⚠️ Texte suspect (liste de logements ou de dates) : critère séjour ignoré, ...' + String(from).slice(-3));
    registerFailedAttempt(conv, text, from, ambiguous || ctx.sprayed);
    return null;
  } catch (err) {
    console.error('Erreur identifyWhatsAppGuest:', err.message);
    return null;
  }
}

// Réservations actives qui ressemblent à ce que dit le voyageur (pour aider le propriétaire à valider à la main)
async function candidateBookings(text, limit = 3) {
  try {
    const bookings = await getAllActiveBookings();
    const norm = normalizeText(text);
    const words = new Set(norm.split(/[^a-z0-9]+/).filter(w => w.length >= 3));
    return bookings.filter(b =>
      [...tokens(b.firstName), ...tokens(b.lastName)].some(t => t.length >= 3 && words.has(t)) || stayDatesMatch(b, norm)
    ).slice(0, limit);
  } catch (err) {
    return [];
  }
}

module.exports = {
  lastNameTokens,
  webIdentityScore,
  verifyGuestIdentity,
  EMAIL_RE,
  PHONE_RE,
  MONTH_NAMES,
  monthIn,
  stayDatesMatch,
  extractUnits,
  waNameMatches,
  waIdentityScore,
  countDayNumbers,
  looksLikeIdentityAttempt,
  buildWaCtx,
  pickBestBooking,
  registerFailedAttempt,
  identifyWhatsAppGuest,
  candidateBookings
};

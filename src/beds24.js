/*
 * beds24.js — Beds24 : jeton, propriété, réservations actives, disponibilités, messages, plateforme détectée
 * (extrait de l'ancien server.js ; voir server.js pour l'architecture)
 */

const { FORMER_GUEST_PAST_ONLY, FORMER_GUEST_STATUSES, hasRealEmail } = require('./config');
const { AIRBNB_LINKS, buildRoomNumbers, flattenFeatures } = require('./rooms');
const { addDays, fetchT, normalizeText, normalizeWaNumber, parisToday, tokens } = require('./utils');

const BEDS24_MAX_PAGES = Math.min(Math.max(Number(process.env.BEDS24_MAX_PAGES) || 3, 1), 10);

// Liste Beds24 paginée : lit jusqu'à maxPages pages (page=2, 3... tant que Beds24 annonce une page suivante)
async function fetchBeds24List(pathAndQuery, token, maxPages = BEDS24_MAX_PAGES) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    const url = `https://beds24.com/api/v2/${pathAndQuery}${page > 1 ? `${sep}page=${page}` : ''}`;
    const response = await fetchT(url, { headers: { token } });
    if (!response.ok) {
      if (page === 1) return { ok: false, status: response.status, data: null };
      console.warn('⚠️ Beds24 : page', page, 'illisible (', response.status, '), résultats partiels');
      break;
    }
    const raw = await response.json();
    const list = raw?.data || raw;
    if (!Array.isArray(list)) {
      if (page === 1) return { ok: true, status: response.status, data: null, raw };
      break;
    }
    out.push(...list);
    if (!raw?.pages?.nextPageExists) break;
    if (page === maxPages) console.warn(`⚠️ Beds24 : résultats limités à ${maxPages} page(s) pour ${pathAndQuery.split('?')[0]}`);
  }
  return { ok: true, status: 200, data: out };
}

// ==================== BEDS24 : TOKEN ====================

let beds24Token = null;
let tokenExpiry = 0;
let beds24RefreshOverride = null; // refresh token obtenu via /setup-beds24 (valable jusqu'au redémarrage)

async function getBeds24Token() {
  const now = Date.now();
  if (beds24Token && now < tokenExpiry - 300000) return beds24Token;
  const refreshToken = (beds24RefreshOverride || process.env.BEDS24_REFRESH_TOKEN || '').replace(/["',\s{}]/g, '');
  if (!refreshToken) return null;
  try {
    const response = await fetchT('https://beds24.com/api/v2/authentication/token', {
      headers: { 'refreshToken': refreshToken }
    }, 10000);
    const data = await response.json();
    if (data.token) {
      beds24Token = data.token;
      tokenExpiry = now + (data.expiresIn * 1000);
      console.log('Token Beds24 renouvelé');
      return beds24Token;
    }
    console.error('Token Beds24 non reçu:', JSON.stringify(data).substring(0, 200));
    return null;
  } catch (err) {
    console.error('Erreur token:', err.message);
    return null;
  }
}

// Session Beds24 obtenue via /setup-beds24 (valable jusqu'au redémarrage)
function setBeds24Session(data) {
  beds24RefreshOverride = data.refreshToken;
  beds24Token = data.token || null;
  tokenExpiry = data.token ? Date.now() + ((data.expiresIn || 86400) * 1000) : 0;
}
function getBeds24RefreshOverride() { return beds24RefreshOverride; }

let propertyCache = null;
let propertyCacheTime = 0;

async function getPropertyInfo() {
  const now = Date.now();
  if (propertyCache && now - propertyCacheTime < 3600000) return propertyCache;
  try {
    const token = await getBeds24Token();
    if (!token) return propertyCache; // ancien cache si disponible
    const response = await fetchT('https://beds24.com/api/v2/properties?includeAllRooms=true&includeTexts=true', {
      headers: { 'token': token }
    });
    const raw = await response.json();
    const prop = raw?.data?.[0] || raw?.[0] || raw;
    const roomList = prop?.roomTypes || prop?.rooms || [];
    propertyCache = {
      digicode: prop?.templates?.template1 || '',
      wifi_password: prop?.templates?.template2 || '',
      rooms: roomList.map(room => ({
        id: room.id,
        name: room.templates?.template2 || room.name || '',
        codeBoite: room.templates?.template1 || '',
        emplacement: room.templates?.template3 || '',
        wifi: room.templates?.template4 || prop?.templates?.template2 || '',
        size: Number(room.roomSize) || null,
        maxPeople: Number(room.maxPeople) || null,
        features: flattenFeatures(room.featureCodes),
      }))
    };
    propertyCacheTime = now;
    console.log('Propriété chargée — logements:', propertyCache.rooms.length);
    return propertyCache;
  } catch (err) {
    console.error('Erreur propriété:', err.message);
    return propertyCache;
  }
}

// Séjour actif : du jour qui précède l'arrivée jusqu'au jour du départ INCLUS (heure de Paris).
// (Avant : la fenêtre se fermait à minuit au début du jour de départ, donc plus de codes le matin du départ.)
function isActiveStay(b, today = parisToday()) {
  const a = String(b?.arrival || '').slice(0, 10);
  const d = String(b?.departure || '').slice(0, 10);
  if (!a || !d) return false;
  return addDays(a, -1) <= today && today <= d;
}

// Réservations actives (cache 60 s pour ne pas interroger Beds24 à chaque message)
let activeBookingsCache = { at: 0, data: [] };

async function getAllActiveBookings() {
  if (Date.now() - activeBookingsCache.at < 60000) return activeBookingsCache.data;
  try {
    const token = await getBeds24Token();
    if (!token) return [];

    const today = parisToday();
    const res = await fetchBeds24List(`bookings?departureFrom=${addDays(today, -1)}&arrivalTo=${addDays(today, 1)}&status=confirmed&maxResults=100`, token);
    const bookings = res.data;
    if (!res.ok || !Array.isArray(bookings)) return [];

    const active = bookings.filter(b => isActiveStay(b, today));
    activeBookingsCache = { at: Date.now(), data: active };
    return active;
  } catch (err) {
    console.error('Erreur getAllActiveBookings:', err.message);
    return [];
  }
}


// Séjours en cours et à venir (arrivée dans les `days` prochains jours), pour la commande /sejour.
// Seulement les réservations confirmées : ni demandes, ni annulations, ni blocages. null si Beds24 est injoignable.
async function getStays(days = 30) {
  try {
    const token = await getBeds24Token();
    if (!token) return null;
    const today = parisToday();
    const res = await fetchBeds24List(`bookings?departureFrom=${today}&arrivalTo=${addDays(today, days)}&maxResults=200`, token);
    if (!res.ok || !Array.isArray(res.data)) return null;
    return res.data
      .filter(b => b && !isBlockBooking(b) && ['confirmed', 'new'].includes(String(b.status || '').toLowerCase()))
      .filter(b => String(b.departure || '').slice(0, 10) >= today && String(b.arrival || '').slice(0, 10) <= addDays(today, days))
      .sort((x, y) => String(x.arrival).localeCompare(String(y.arrival)) || String(x.roomId).localeCompare(String(y.roomId)));
  } catch (err) {
    console.error('Erreur getStays:', err.message);
    return null;
  }
}

// ---------- Anciens voyageurs ----------
// Un voyageur est "ancien" à partir de FORMER_GUEST_MIN_BOOKINGS séjours. Règles de comptage (maîtrisées) :
// - adresse email EXACTE et réelle (pas d'adresse relais Airbnb/Booking : propre à une seule réservation) ;
// - seulement les statuts de FORMER_GUEST_STATUSES (par défaut : confirmed) : ni annulées, ni demandes, ni blocages ;
// - seulement les séjours déjà commencés (FORMER_GUEST_PAST_ONLY=off pour compter aussi les séjours à venir) ;
// - chaque réservation n'est comptée qu'une fois ; résultat gardé 30 min (économise le quota Beds24).
// La réservation en cours est comptée dans le total.
const GUEST_COUNT_TTL_MS = 30 * 60 * 1000;
const guestCountCache = new Map(); // email -> { at, n }

function countsAsFormerStay(b, email, today = parisToday()) {
  if (!b || isBlockBooking(b)) return false;
  if (String(b.email || '').toLowerCase().trim() !== email) return false; // searchString est une recherche floue : on exige l'égalité
  if (!FORMER_GUEST_STATUSES.includes(String(b.status || '').toLowerCase())) return false;
  if (FORMER_GUEST_PAST_ONLY) {
    const arrival = String(b.arrival || '').slice(0, 10);
    if (!arrival || arrival > today) return false;
  }
  return true;
}

async function countGuestBookings(guestEmail) {
  const email = String(guestEmail || '').toLowerCase().trim();
  if (!email || !hasRealEmail({ email })) return 0;
  const hit = guestCountCache.get(email);
  if (hit && Date.now() - hit.at < GUEST_COUNT_TTL_MS) return hit.n;
  try {
    const token = await getBeds24Token();
    if (!token) return 0;
    const res = await fetchBeds24List(`bookings?searchString=${encodeURIComponent(email)}&maxResults=100`, token);
    if (!res.ok || !Array.isArray(res.data)) return 0; // erreur : rien n'est mis en cache
    const ids = new Set();
    for (const b of res.data) if (b && b.id != null && countsAsFormerStay(b, email)) ids.add(String(b.id));
    if (guestCountCache.size > 500) guestCountCache.clear();
    guestCountCache.set(email, { at: Date.now(), n: ids.size });
    return ids.size;
  } catch (err) {
    return 0;
  }
}

// Logements libres / occupés pour des dates données, d'après les réservations Beds24
async function checkAvailability(arrival, departure, excludeBookingId = null) {
  const token = await getBeds24Token();
  if (!token) return null;
  const propInfo = await getPropertyInfo();
  if (!propInfo || !propInfo.rooms || propInfo.rooms.length === 0) {
    console.log('📅 Vérification impossible : logements Beds24 non chargés');
    return null;
  }

  const lastNight = addDays(departure, -1);
  const firstDeparture = addDays(arrival, 1);
  const res = await fetchBeds24List(`bookings?arrivalTo=${lastNight}&departureFrom=${firstDeparture}&maxResults=200`, token);
  if (!res.ok) {
    console.error('Erreur disponibilités Beds24:', res.status);
    return null;
  }
  const bookings = res.data;
  if (!Array.isArray(bookings)) {
    console.log('📅 Réponse Beds24 inattendue :', JSON.stringify(res.raw).substring(0, 200));
    return null;
  }

  const busy = new Set(
    bookings
      .filter(b => !['cancelled', 'inquiry'].includes((b.status || '').toLowerCase()))
      .filter(b => !excludeBookingId || String(b.id) !== String(excludeBookingId)) // ignorer la réservation examinée
      .filter(b => b.arrival < departure && b.departure > arrival) // chevauchement réel
      .map(b => String(b.roomId))
  );
  console.log(`📅 Disponibilités ${arrival} → ${departure} | réservations en conflit: ${busy.size}`);

  const free = [];
  const occupied = [];
  const freeIds = [];
  const roomNumbers = buildRoomNumbers(propInfo);
  for (const room of propInfo.rooms) {
    const name = room.name || `Logement ${room.id}`;
    const link = AIRBNB_LINKS.find(l => l.num === roomNumbers.get(String(room.id)));
    const label = link ? `Logement ${link.num} - ${link.nom} (Airbnb : ${link.lien})` : name;
    if (busy.has(String(room.id))) occupied.push(label);
    else { free.push(label); freeIds.push(String(room.id)); }
  }
  return { free, occupied, freeIds };
}

// Origine de la réservation, d'après la fiche Beds24 : 'airbnb', 'booking', 'direct' (site) ou 'inconnue'.
// On regarde d'abord channel / apiSource (fiables) ; le referer ne sert qu'en dernier recours.
function detectPlatform(b) {
  if (!b) return 'inconnue';
  const src = normalizeText([b.channel, b.apiSource].filter(Boolean).join(' '));
  if (/airbnb/.test(src)) return 'airbnb';
  if (/booking/.test(src)) return 'booking';
  if (/direct/.test(src)) return 'direct';
  const ref = normalizeText(b.referer || '');
  if (/airbnb/.test(ref)) return 'airbnb';
  if (/booking\.com/.test(ref)) return 'booking';
  return 'inconnue';
}

// Réservation retrouvée par son numéro (celui du message), quelles que soient les dates
const bookingByIdCache = new Map();
async function getBookingById(id) {
  const key = String(id);
  const hit = bookingByIdCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.data;
  try {
    const token = await getBeds24Token();
    if (!token) return null;
    const response = await fetchT(`https://beds24.com/api/v2/bookings?id=${encodeURIComponent(key)}`, { headers: { 'token': token } });
    if (!response.ok) { console.error('Erreur réservation Beds24:', response.status); return null; }
    const raw = await response.json();
    const list = raw?.data || raw;
    const b = Array.isArray(list) ? list.find(x => String(x.id) === key) || null : null;
    bookingByIdCache.set(key, { at: Date.now(), data: b });
    return b;
  } catch (err) {
    console.error('Erreur getBookingById:', err.message);
    return null;
  }
}

// Envoie un message "hôte" sur une réservation Beds24 (relayé vers Airbnb / Booking par le channel manager)
async function sendBeds24Message(token, bookingId, text) {
  try {
    const response = await fetchT('https://beds24.com/api/v2/bookings/messages', {
      method: 'POST',
      headers: { 'token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ bookingId: Number(bookingId) || bookingId, message: text }])
    });
    console.log(response.ok ? '✅ Message Beds24 envoyé' : '❌ Message Beds24 REFUSÉ', '| booking:', bookingId, '| status:', response.status);
    if (!response.ok) {
      console.error('Détail erreur Beds24:', (await response.text()).substring(0, 300));
      if (response.status === 401 || response.status === 403) console.error('👉 Le jeton Beds24 peut lire mais pas écrire les messages : vérifiez ses droits avec /debug-beds24-token');
    }
    return response.ok;
  } catch (err) {
    console.error('Erreur envoi Beds24:', err.message);
    return false;
  }
}

// Téléphone du voyageur au format WhatsApp (indicatif pays, sans +), ou null. "mobile" passe avant "phone".
function bookingPhone(b) {
  for (const raw of [b?.mobile, b?.phone]) {
    const n = normalizeWaNumber(raw).replace(/^330/, '33'); // "+33 (0)6..." -> 336...
    if (n.length >= 9 && n.length <= 15) return n;
  }
  return null;
}

function maskPhone(p) { return p ? `+…${String(p).slice(-3)}` : null; }

// Blocages saisis comme réservations (ex. prénom/nom "Travaux", "Bloqué", "Maintenance") : jamais d'alerte.
// Modifiable sur Render : IGNORE_BOOKING_NAMES="travaux,bloque,maintenance" (mots séparés par des virgules, sans accents ni majuscules).
const IGNORE_BOOKING_NAMES = (process.env.IGNORE_BOOKING_NAMES || 'travaux,bloque,blocage,maintenance,indisponible,fermeture,proprietaire')
  .split(',').map(s => normalizeText(s).trim()).filter(Boolean);
function isBlockBooking(b) {
  const words = new Set(tokens(`${b?.firstName || ''} ${b?.lastName || ''}`));
  return IGNORE_BOOKING_NAMES.some(n => words.has(n));
}

module.exports = {
  BEDS24_MAX_PAGES,
  fetchBeds24List,
  getBeds24Token,
  setBeds24Session,
  getBeds24RefreshOverride,
  getPropertyInfo,
  isActiveStay,
  getAllActiveBookings,
  getStays,
  GUEST_COUNT_TTL_MS,
  guestCountCache,
  countsAsFormerStay,
  countGuestBookings,
  checkAvailability,
  detectPlatform,
  bookingByIdCache,
  getBookingById,
  sendBeds24Message,
  bookingPhone,
  maskPhone,
  IGNORE_BOOKING_NAMES,
  isBlockBooking
};

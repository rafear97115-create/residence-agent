/*
 * platforms.js — Messages Airbnb / Booking : relève Beds24 toutes les 2 min, rattrapage, réponse
 * (extrait de l'ancien server.js ; voir server.js pour l'architecture)
 */

const { generateCourtesyReply, isPureCourtesy, runConversation } = require('./ai');
const { notifyOwner, parseAlert } = require('./alerts');
const { countGuestBookings, detectPlatform, fetchBeds24List, getBeds24Token, getBookingByIdSafe, getPropertyInfo, isActiveStay, sendBeds24Message } = require('./beds24');
const { AGENT_START_TIME, FORMER_GUEST_MIN_BOOKINGS } = require('./config');
const { alertBeds24Down, sendOwnerAlert } = require('./messaging');
const { buildSystemPrompt, ensurePrivacyNote, ensureSignature, hasIntro } = require('./prompts');
const { applyAddressPolicy, applyPhonePolicy, rateLimit } = require('./security');
const { COURTESY_WINDOW_MS, courtesyAt, introducedBookings, isPaused, markDirty } = require('./state');
const { logName, logText } = require('./utils');

// ==================== BEDS24 : MESSAGES (Airbnb / Booking) ====================

const processedMessages = new Set();
const beds24Attempts = new Map();

// Rattrapage : un message reçu pendant que le bot dormait ou redémarrait n'est plus ignoré.
// Il est traité s'il a moins de CATCHUP_HOURS heures ET si personne (propriétaire, message automatique) n'a répondu depuis.
const CATCHUP_MS = (Number(process.env.CATCHUP_HOURS) || 12) * 3600 * 1000;

function catchupDecision(msg, all, now = Date.now(), start = AGENT_START_TIME) {
  const t = new Date(msg.time);
  if (t >= start) return { catchup: false, answer: true };
  if (now - t > CATCHUP_MS) return { catchup: true, answer: false };
  const bid = String(messageBookingId(msg));
  const answered = all.some(m => messageSource(m) !== 'guest' && String(messageBookingId(m)) === bid && m.time && new Date(m.time) > t);
  return { catchup: true, answer: !answered };
}
let polling = false;

// Panne Beds24 : 2 relevés ratés de suite (environ 4 min) = alerte au propriétaire (1 par heure au plus) ; retour à la normale = un message
let beds24Failures = 0;
let beds24DownAlerted = false;
function noteBeds24Failure(reason) {
  beds24Failures++;
  if (beds24Failures >= 2) alertBeds24Down(reason).then(sent => { if (sent) beds24DownAlerted = true; });
}
function noteBeds24Ok() {
  beds24Failures = 0;
  if (beds24DownAlerted) {
    beds24DownAlerted = false;
    sendOwnerAlert('✅ Beds24 répond de nouveau : le bot a repris les messages Airbnb / Booking. Les messages reçus pendant la panne ne sont pas traités : vérifiez-les dans Airbnb / Booking.').catch(() => {});
  }
}

function messageBookingId(msg) {
  return msg.bookingId || msg.booking_id || msg.bookId || null;
}

function messageSource(msg) {
  return msg.source || msg.type || '';
}

function messageText(msg) {
  return String(msg.message || msg.text || '').trim();
}

// Messages consécutifs du même auteur fusionnés en un seul
function mergeRoles(msgs) {
  const out = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

// Fil de discussion d'une réservation (voyageur = user, hôte = assistant), avant l'instant "before"
function buildBeds24History(all, bookingId, before) {
  const rows = all
    .filter(m => String(messageBookingId(m)) === String(bookingId) && m.time && new Date(m.time) < before && messageText(m))
    .sort((a, b) => new Date(a.time) - new Date(b.time))
    .map(m => ({ role: messageSource(m) === 'guest' ? 'user' : 'assistant', content: messageText(m).slice(0, 1500) }));
  const merged = mergeRoles(rows).slice(-10);
  while (merged.length && merged[0].role !== 'user') merged.shift();
  return merged;
}

// Répond à un ou plusieurs messages consécutifs d'un même voyageur (une seule réponse)
async function handleBeds24Group(token, propInfo, bookingId, group, all) {
  const timeOf = m => new Date(m.time);
  group.sort((a, b) => timeOf(a) - timeOf(b));
  const ids = group.map(m => m.id || m.messageId);
  const markDone = () => ids.forEach(id => processedMessages.add(id));
  const combined = group.map(messageText).join('\n');
  const attemptKey = String(ids[ids.length - 1]);

  console.log(`\n📨 Beds24 | réservation ${bookingId} | ${group.length} message(s) | ${logText(combined, 100)}`);

  // Le propriétaire a coupé le bot sur cette réservation (/pause bID)
  if (isPaused(`b${bookingId}`)) {
    console.log(`⏸️ Réservation ${bookingId} en pause, pas de réponse`);
    markDone();
    return;
  }

  const history = buildBeds24History(all, bookingId, timeOf(group[0]));
  const lastEntry = history[history.length - 1];
  const lastAssistant = lastEntry ? (lastEntry.role === 'assistant' ? lastEntry.content : '') : null;

  // Simple politesse : une réponse brève, une seule fois par période
  if (isPureCourtesy(combined, lastAssistant)) {
    markDone();
    if (group.some(m => m._catchup)) { console.log('🙏 Politesse reçue pendant l\'arrêt : pas de réponse tardive'); return; }
    if (Date.now() - (courtesyAt.get(String(bookingId)) || 0) < COURTESY_WINDOW_MS) {
      console.log('🙏 Politesse déjà acquittée, pas de réponse');
      return;
    }
    const thanks = await generateCourtesyReply(combined, history);
    if (thanks && await sendBeds24Message(token, bookingId, thanks)) courtesyAt.set(String(bookingId), Date.now());
    return;
  }

  // Réservation retrouvée par son numéro : plus de confusion possible entre deux voyageurs du même logement
  const found = await getBookingByIdSafe(bookingId);
  if (!found.ok) {
    // Beds24 ne répond pas : le bot ne devine rien et ne répond pas. Simple alerte (avec le message), le propriétaire répond à la main.
    // Le message est marqué traité : le bot ne répondra pas après coup, par-dessus la réponse du propriétaire.
    markDone();
    console.error(` ⚠️ Beds24 injoignable pour la réservation ${bookingId} : aucune réponse automatique`);
    if (rateLimit(`beds24down:msg:${bookingId}`, 3, 3600 * 1000)) {
      await sendOwnerAlert(`⚠️ Beds24 injoignable : le message de la réservation ${bookingId} n'a pas été traité par le bot. Répondez-lui directement dans Airbnb / Booking.\n\nMessage : « ${combined.substring(0, 600)} »`);
    }
    return;
  }
  const booking = found.data;
  const confirmed = booking && String(booking.status || '').toLowerCase() === 'confirmed';
  const activeBooking = confirmed && isActiveStay(booking) ? booking : null;
  const platform = detectPlatform(booking);
  // Réservation confirmée mais séjour pas encore commencé (ou déjà terminé) : le bot la connaît, sans donner aucun code
  const knownBooking = confirmed && !activeBooking ? booking : null;
  const roomInfo = activeBooking && propInfo ? propInfo.rooms.find(r => String(r.id) === String(activeBooking.roomId)) || null : null;
  const isLoyal = (await countGuestBookings(booking?.email || null)) >= FORMER_GUEST_MIN_BOOKINGS;
  console.log(` Réservation: ${logName(booking)} | codes autorisés: ${!!activeBooking} | plateforme: ${platform} (channel: ${booking?.channel ?? '-'}) | fidèle: ${isLoyal} | historique: ${history.length} message(s)`);

  const introduced = introducedBookings.has(String(bookingId)) || hasIntro(history);
  const systemPrompt = buildSystemPrompt({ propInfo, roomInfo, booking: activeBooking, isLoyal, channel: 'platform', platform, introduced, knownBooking });
  const rawReply = await runConversation({ system: systemPrompt, messages: mergeRoles([...history, { role: 'user', content: combined }]) });
  const parsed = rawReply ? parseAlert(rawReply, combined) : null;
  // jamais l'adresse exacte sur les plateformes ; le numéro d'urgence seulement pour un séjour en cours
  if (parsed) parsed.reply = ensureSignature(ensurePrivacyNote(applyPhonePolicy(applyAddressPolicy(parsed.reply, false), !!activeBooking), introduced), introduced);

  let ok = false;
  if (parsed && parsed.reply) {
    console.log(` Réponse: ${logText(parsed.reply, 100)} | alerte: ${parsed.category}`);
    ok = await sendBeds24Message(token, bookingId, parsed.reply);
    if (ok) {
      if (/assistant virtuel/i.test(parsed.reply)) { introducedBookings.set(String(bookingId), Date.now()); markDirty(); }
      await notifyOwner({ channel: `Beds24 / ${platform}`, contact: `réservation ${bookingId}`, bookingId, question: combined, reply: parsed.reply, category: parsed.category, booking });
    }
  }

  if (ok) {
    markDone();
  } else {
    const n = ((beds24Attempts.get(attemptKey) || {}).n || 0) + 1;
    beds24Attempts.set(attemptKey, { n, t: Date.now() });
    if (n >= 3) {
      markDone();
      console.error(` ❌ Réservation ${bookingId} abandonnée après ${n} tentatives`);
      await notifyOwner({ channel: `Beds24 / ${platform}`, contact: `réservation ${bookingId}`, bookingId, question: combined, reply: '(aucune réponse envoyée)', category: 'erreur_ia', booking });
    } else {
      console.log(` ⚠️ Échec (tentative ${n}/3), nouvel essai au prochain passage`);
    }
  }
}

async function fetchAndReplyBeds24Messages() {
  if (polling) return; // évite deux passages en parallèle
  polling = true;
  try {
    const token = await getBeds24Token();
    if (!token) { noteBeds24Failure('jeton indisponible'); return; }
    const propInfo = await getPropertyInfo();

    const res = await fetchBeds24List('bookings/messages?maxResults=100', token);
    if (!res.ok) {
      console.log('Erreur messages Beds24:', res.status);
      noteBeds24Failure(`erreur ${res.status}`);
      return;
    }
    const all = res.data;
    if (!Array.isArray(all)) return;
    noteBeds24Ok();

    // Nouveaux messages de voyageurs, regroupés par réservation
    const groups = new Map();
    for (const msg of all) {
      const msgId = msg.id || msg.messageId;
      if (!msgId || processedMessages.has(msgId)) continue;
      // Ignorer : pas un message voyageur, ou vide
      if (!msg.time || messageSource(msg) !== 'guest' || !messageText(msg)) {
        processedMessages.add(msgId);
        continue;
      }
      // Message antérieur au démarrage : rattrapé seulement s'il est récent et sans réponse
      const dec = catchupDecision(msg, all);
      if (!dec.answer) {
        processedMessages.add(msgId);
        continue;
      }
      if (dec.catchup) {
        msg._catchup = true;
        console.log(`📬 Rattrapage : message ${msgId} reçu à ${msg.time}, pendant l'arrêt du bot`);
      }
      const bookingId = messageBookingId(msg);
      if (!bookingId) {
        console.error(` ⚠️ Message Beds24 ${msgId} sans numéro de réservation : ignoré`);
        processedMessages.add(msgId);
        continue;
      }
      const key = String(bookingId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(msg);
    }

    for (const [bookingId, group] of groups) {
      await handleBeds24Group(token, propInfo, bookingId, group, all);
    }
    if (groups.size > 0) console.log(`\n✅ ${groups.size} conversation(s) Beds24 examinée(s)`);
  } catch (err) {
    console.error('Erreur polling Beds24:', err.message);
    noteBeds24Failure('réseau');
  } finally {
    polling = false;
  }
}

module.exports = {
  processedMessages,
  beds24Attempts,
  CATCHUP_MS,
  catchupDecision,
  messageBookingId,
  messageSource,
  messageText,
  mergeRoles,
  buildBeds24History,
  handleBeds24Group,
  fetchAndReplyBeds24Messages
};

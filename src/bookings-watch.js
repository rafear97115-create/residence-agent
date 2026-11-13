/*
 * bookings-watch.js — Surveillance des demandes en attente et des réservations directes (alertes propriétaire)
 * (extrait de l'ancien server.js ; voir server.js pour l'architecture)
 */

const { fmtDate } = require('./alerts');
const { bookingPhone, checkAvailability, detectPlatform, fetchBeds24List, getBeds24Token, getPropertyInfo, getUpcomingConfirmed, isBlockBooking, sendBeds24Message } = require('./beds24');
const { AGENT_START_TIME, CANCEL_WATCH, MODIFY_WATCH, PENDING_ACK, PENDING_WATCH } = require('./config');
const { sendOwnerAlert } = require('./messaging');
const { SIGNATURE } = require('./prompts');
const { describeRoom } = require('./rooms');
const { BASELINE_GRACE_MS, bookingFingerprints, introducedBookings, isPaused, markDirty, runtime, seenBookingEvents } = require('./state');
const { parisToday } = require('./utils');

// ==================== DEMANDES EN ATTENTE ET RÉSERVATIONS DIRECTES (Beds24) ====================
// Toutes les 2 minutes, le bot regarde les réservations récentes de Beds24 et prévient le propriétaire :
// - d'une demande en attente (statut inquiry / request). Airbnb envoie aussi les simples questions sur les dates en "inquiry" ;
// - d'une nouvelle réservation confirmée : directe (site) ou Airbnb / Booking (réservation instantanée, ou demande acceptée) ;
// - de l'ANNULATION d'une réservation (CANCEL_WATCH=off pour désactiver) ;
// - de la MODIFICATION des dates ou du logement d'une réservation confirmée (MODIFY_WATCH=off pour désactiver). Le bot mémorise les dates et le
//   logement connus de chaque réservation confirmée (« empreinte », voir state.js) et compare à chaque passage.
// Le bot ne peut ni accepter ni refuser une demande : cela reste à faire dans Airbnb / Booking.


const PENDING_STATUSES = ['inquiry', 'request'];
const DIRECT_STATUSES = ['confirmed', 'new'];

const bookingEventAttempts = new Map();
let watchingBookings = false;

// Annulation à signaler ? Pas pour un séjour déjà terminé, ni pour une simple DEMANDE qui n'a jamais été confirmée puis a expiré ou été refusée
// (Airbnb passe alors la fiche en « cancelled » : ce n'est pas l'annulation d'une réservation).
function cancellationKind(b, today = parisToday()) {
  if (!CANCEL_WATCH) return null;
  const d = String(b?.departure || '').slice(0, 10);
  if (!d || d < today) return null;
  const known = k => seenBookingEvents.has(`${b.id}:${k}`);
  if (known('pending') && !known('confirmed') && !known('direct')) return null;
  return 'cancelled';
}

// 'pending' (demande en attente), 'direct' (nouvelle réservation du site), 'confirmed' (nouvelle réservation Airbnb / Booking / origine inconnue)
// 'cancelled' (réservation annulée) ou null (rien à signaler)
function bookingEventKind(b, sinceMs = 0) {
  if (isBlockBooking(b)) return null;
  const status = String(b?.status || '').toLowerCase();
  if (PENDING_STATUSES.includes(status)) return 'pending';
  if (status === 'cancelled') return cancellationKind(b);
  if (DIRECT_STATUSES.includes(status)) {
    const kind = detectPlatform(b) === 'direct' ? 'direct' : 'confirmed';
    // Une demande déjà signalée (pending) qui devient confirmée (demande acceptée) est signalée même si la demande date de plus de 12 h
    if (kind === 'confirmed' && seenBookingEvents.has(`${b.id}:pending`)) return kind;
    // Réservation créée récemment seulement : modifier une ancienne fiche dans Beds24 ne doit pas relancer d'alerte
    const created = Date.parse(b.bookingTime || b.modifiedTime || '');
    // Aucune date exploitable : on alerte quand même (la liste est déjà limitée aux réservations modifiées récemment,
    // et l'anti-doublon conservé dans le fichier d'état empêche d'envoyer deux fois la même alerte)
    if (Number.isNaN(created) || created >= sinceMs) return kind;
  }
  return null;
}

function formatBookingAlert(b, kind, propInfo, availability = null, previous = null) {
  const origin = detectPlatform(b);
  const originLabel = { airbnb: 'Airbnb', booking: 'Booking', direct: 'Site (réservation directe)' }[origin] || 'Origine inconnue';
  const nm = `${b.firstName || ''} ${b.lastName || ''}`.trim();
  const phone = bookingPhone(b);
  const a = String(b.arrival || '').slice(0, 10);
  const d = String(b.departure || '').slice(0, 10);
  const nights = (a && d) ? Math.round((new Date(d + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000) : null;

  let t = {
    pending: '📩 Demande en attente (demande de réservation ou question sur les dates)',
    confirmed: `✅ Nouvelle réservation confirmée (${originLabel})`,
    direct: '🆕 Nouvelle réservation directe (site)',
    cancelled: `❌ Réservation ANNULÉE (${originLabel})`,
    modified: `🔄 Réservation MODIFIÉE (${originLabel})`
  }[kind] || '📩 Réservation';
  t += `\nPlate-forme (réservation) : ${originLabel} (${b.id})`;
  t += `\nVoyageur : ${nm || 'inconnu'}`;
  t += phone ? `\nTéléphone : +${phone}\nWhatsApp : https://wa.me/${phone}` : '\nTéléphone : non enregistré dans Beds24';
  const nightsText = n => (Number.isFinite(n) && n > 0 ? ` (${n} nuit${n > 1 ? 's' : ''})` : '');
  if (kind === 'modified' && previous) {
    const pn = (previous.a && previous.d) ? Math.round((new Date(previous.d + 'T00:00:00Z') - new Date(previous.a + 'T00:00:00Z')) / 86400000) : null;
    t += `\nAvant : ${describeRoom(previous.r, propInfo)} · du ${fmtDate(previous.a)} au ${fmtDate(previous.d)}${nightsText(pn)}`;
    t += `\nAprès : ${describeRoom(b.roomId, propInfo)} · du ${fmtDate(b.arrival)} au ${fmtDate(b.departure)}${nightsText(nights)}`;
  } else {
    t += `\nLogement : ${describeRoom(b.roomId, propInfo)}`;
    t += `\nSéjour : ${fmtDate(b.arrival)} au ${fmtDate(b.departure)}${nightsText(nights)}`;
  }
  if (kind !== 'pending') t += `\nStatut Beds24 : ${b.status}`;
  const price = Number(b.price);
  if (price > 0) t += `\nPrix (Beds24) : ${price} €`;

  if (kind === 'pending') {
    if (availability) t += availability.free ? '\nDisponibilité : ce logement est libre sur ces dates' : '\nDisponibilité : ⚠️ ce logement est déjà pris sur ces dates';
    else t += '\nDisponibilité : non vérifiée';
  }
  if (Number.isFinite(nights) && nights > 90) t += '\n⚠️ Dépasse la durée maximale de 90 jours.';
  else if (Number.isFinite(nights) && nights >= 32) t += '\n💼 Long séjour (32 nuits ou plus) : proposition personnalisée à faire.';

  const comment = String(b.comments || '').trim();
  if (comment) t += `\nMessage du voyageur : ${comment.substring(0, 400)}`;
  const note = String(b.notes || '').trim();
  if (note) t += `\nNote Beds24 : ${note.substring(0, 200)}`;

  if (kind === 'pending') {
    t += origin === 'direct'
      ? `\n\nÀ confirmer avec le voyageur${phone ? ' sur WhatsApp' : ''}.`
      : `\n\nÀ traiter dans ${originLabel} : le bot ne peut ni accepter ni refuser la demande.`;
  } else if (kind === 'cancelled') {
    t += '\n\nPensez à vérifier que les dates sont bien rouvertes à la vente sur toutes les plateformes.';
  } else if (kind === 'modified') {
    t += `\n\nSi la modification n'est pas de vous, vérifiez-la dans ${originLabel} / Beds24.${origin === 'direct' ? '' : `\nPour écrire au voyageur : /repondre b${b.id} votre message`}`;
  } else if (kind === 'direct' && !phone) {
    t += '\n\nPensez à demander son numéro au voyageur.';
  } else if (kind === 'confirmed') {
    t += `\n\nPour écrire au voyageur : /repondre b${b.id} votre message`;
  }
  return t;
}

// Le logement demandé est-il libre ? (la réservation examinée est ignorée dans le calcul)
async function availabilityForBooking(b) {
  try {
    const a = String(b.arrival || '').slice(0, 10);
    const d = String(b.departure || '').slice(0, 10);
    if (!a || !d || a < parisToday() || d <= a) return null;
    const r = await checkAvailability(a, d, b.id);
    if (!r) return null;
    return { free: r.freeIds.includes(String(b.roomId)) };
  } catch (err) {
    console.error('Erreur disponibilité demande:', err.message);
    return null;
  }
}

async function announceBooking(token, b, kind, propInfo, previous = null) {
  const availability = kind === 'pending' ? await availabilityForBooking(b) : null;
  const ok = await sendOwnerAlert(formatBookingAlert(b, kind, propInfo, availability, previous).substring(0, 4000));
  console.log(ok ? '📩 Alerte envoyée' : '❌ Alerte NON envoyée', `| réservation ${b.id} | ${kind} | origine: ${detectPlatform(b)} | téléphone: ${bookingPhone(b) ? 'oui' : 'non'}`);
  const origin = detectPlatform(b);
  if (ok && PENDING_ACK && kind === 'pending' && (origin === 'airbnb' || origin === 'booking') && !isPaused(`b${b.id}`)) {
    const msg = `Bonjour, je suis l'assistant virtuel de la Résidence de l'Industrie. Votre demande a bien été reçue et transmise au Service Relation Client, qui reviendra vers vous. Elle n'est pas encore confirmée.\n\n${SIGNATURE}`;
    if (await sendBeds24Message(token, b.id, msg)) { introducedBookings.set(String(b.id), Date.now()); markDirty(); }
  }
  return ok;
}

// ---------- Empreintes : dates et logement connus de chaque réservation confirmée ----------
function fingerprintOf(b) {
  const a = String(b?.arrival || '').slice(0, 10);
  const d = String(b?.departure || '').slice(0, 10);
  if (!a || !d) return null;
  return { a, d, r: String(b.roomId ?? '') };
}

// Réservation confirmée dont les dates ou le logement ont changé depuis la dernière empreinte : { previous, current, key }, sinon null.
// Première fois qu'on la voit : l'empreinte est simplement mémorisée (rien à comparer, pas d'alerte).
function detectModification(b) {
  if (!DIRECT_STATUSES.includes(String(b?.status || '').toLowerCase())) return null;
  const cur = fingerprintOf(b);
  if (!cur) return null;
  const id = String(b.id);
  const prev = bookingFingerprints.get(id);
  if (!prev) { bookingFingerprints.set(id, { ...cur, t: Date.now() }); markDirty(); return null; }
  if (prev.a === cur.a && prev.d === cur.d && prev.r === cur.r) return null;
  if (!MODIFY_WATCH) { bookingFingerprints.set(id, { ...cur, t: Date.now() }); markDirty(); return null; } // alertes coupées : on suit sans prévenir
  return { previous: prev, current: cur, key: `${id}:modified:${cur.a}|${cur.d}|${cur.r}` };
}

// Au démarrage : mémorise les réservations confirmées déjà connues de Beds24, sinon la première modification d'une réservation
// créée avant le démarrage du bot ne pourrait pas être détectée (rien à comparer). Ne remplace jamais une empreinte existante.
async function seedFingerprints(attempt = 1) {
  try {
    const list = await getUpcomingConfirmed();
    if (!list) {
      if (attempt < 3) setTimeout(() => seedFingerprints(attempt + 1), 5 * 60 * 1000).unref();
      return 0;
    }
    let added = 0;
    for (const b of list) {
      if (!b || !b.id || isBlockBooking(b) || bookingFingerprints.has(String(b.id))) continue;
      const fp = fingerprintOf(b);
      if (fp) { bookingFingerprints.set(String(b.id), { ...fp, t: Date.now() }); added++; }
    }
    if (added) markDirty();
    console.log(`📋 Empreintes de réservations : ${added} ajoutée(s), ${bookingFingerprints.size} suivie(s)`);
    return added;
  } catch (err) {
    console.error('Erreur seedFingerprints:', err.message);
    return 0;
  }
}

async function checkNewBookings() {
  if (!PENDING_WATCH || watchingBookings) return;
  watchingBookings = true;
  try {
    const token = await getBeds24Token();
    if (!token) return;
    const hours = Number(process.env.PENDING_LOOKBACK_HOURS) || 12;
    const sinceMs = Date.now() - hours * 3600 * 1000;
    const res = await fetchBeds24List(`bookings?modifiedFrom=${encodeURIComponent(new Date(sinceMs).toISOString())}&maxResults=100`, token);
    if (!res.ok) { console.log('Erreur réservations récentes Beds24:', res.status); return; }
    const list = res.data;
    if (!Array.isArray(list)) return;
    const propInfo = await getPropertyInfo();
    const baseline = runtime.bookingBaselinePending;
    for (const b of list) {
      if (!b || !b.id || isBlockBooking(b)) continue;

      // Événements à signaler pour cette réservation : création / demande / annulation, et modification des dates ou du logement
      const events = [];
      const kind = bookingEventKind(b, sinceMs);
      if (kind) events.push({ kind, key: `${b.id}:${kind}`, previous: null });
      const mod = detectModification(b);
      if (mod) events.push({ kind: 'modified', key: mod.key, previous: mod.previous, current: mod.current });

      for (const ev of events) {
        if (seenBookingEvents.has(ev.key)) {
          if (ev.kind === 'modified') { bookingFingerprints.set(String(b.id), { ...ev.current, t: Date.now() }); markDirty(); }
          continue;
        }
        if (baseline && ev.kind !== 'modified') {
          const modified = Date.parse(b.modifiedTime || b.bookingTime || '');
          if (!Number.isNaN(modified) && modified < AGENT_START_TIME.getTime() - BASELINE_GRACE_MS) {
            seenBookingEvents.set(ev.key, Date.now()); markDirty();
            console.log(`📋 Démarrage sans état : ${ev.key} considérée comme déjà signalée`);
            continue;
          }
        }
        const n = ((bookingEventAttempts.get(ev.key) || {}).n || 0) + 1;
        bookingEventAttempts.set(ev.key, { n, t: Date.now() });
        let done = false;
        if (n > 5) { console.error(`❌ Alerte abandonnée après 5 essais : ${ev.key}`); done = true; }
        else done = await announceBooking(token, b, ev.kind, propInfo, ev.previous);
        if (done) {
          seenBookingEvents.set(ev.key, Date.now());
          if (ev.kind === 'modified') bookingFingerprints.set(String(b.id), { ...ev.current, t: Date.now() }); // nouvelle référence
          if (ev.kind === 'cancelled') bookingFingerprints.delete(String(b.id));
          markDirty();
        }
      }
    }
    runtime.bookingBaselinePending = false;
  } catch (err) {
    console.error('Erreur surveillance réservations:', err.message);
  } finally {
    watchingBookings = false;
  }
}

module.exports = {
  PENDING_STATUSES,
  DIRECT_STATUSES,
  bookingEventAttempts,
  bookingEventKind,
  formatBookingAlert,
  availabilityForBooking,
  announceBooking,
  cancellationKind,
  fingerprintOf,
  detectModification,
  seedFingerprints,
  checkNewBookings
};

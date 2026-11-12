/*
 * bookings-watch.js — Surveillance des demandes en attente et des réservations directes (alertes propriétaire)
 * (extrait de l'ancien server.js ; voir server.js pour l'architecture)
 */

const { fmtDate } = require('./alerts');
const { bookingPhone, checkAvailability, detectPlatform, fetchBeds24List, getBeds24Token, getPropertyInfo, isBlockBooking, sendBeds24Message } = require('./beds24');
const { AGENT_START_TIME, PENDING_ACK, PENDING_WATCH } = require('./config');
const { sendOwnerAlert } = require('./messaging');
const { SIGNATURE } = require('./prompts');
const { describeRoom } = require('./rooms');
const { BASELINE_GRACE_MS, introducedBookings, isPaused, markDirty, runtime, seenBookingEvents } = require('./state');
const { parisToday } = require('./utils');

// ==================== DEMANDES EN ATTENTE ET RÉSERVATIONS DIRECTES (Beds24) ====================
// Toutes les 2 minutes, le bot regarde les réservations récentes de Beds24 et prévient le propriétaire :
// - d'une demande en attente (statut inquiry / request). Airbnb envoie aussi les simples questions sur les dates en "inquiry" ;
// - d'une nouvelle réservation directe (site), pour avoir le numéro du voyageur et le joindre sur WhatsApp.
// Le bot ne peut ni accepter ni refuser une demande : cela reste à faire dans Airbnb / Booking.


const PENDING_STATUSES = ['inquiry', 'request'];
const DIRECT_STATUSES = ['confirmed', 'new'];

const bookingEventAttempts = new Map();
let watchingBookings = false;

// 'pending' (demande en attente), 'direct' (nouvelle réservation du site) ou null (rien à signaler)
function bookingEventKind(b, sinceMs = 0) {
  if (isBlockBooking(b)) return null;
  const status = String(b?.status || '').toLowerCase();
  if (PENDING_STATUSES.includes(status)) return 'pending';
  if (detectPlatform(b) === 'direct' && DIRECT_STATUSES.includes(status)) {
    // Réservation créée récemment seulement : modifier une ancienne fiche dans Beds24 ne doit pas relancer d'alerte
    const created = Date.parse(b.bookingTime || b.modifiedTime || '');
    // Aucune date exploitable : on alerte quand même (la liste est déjà limitée aux réservations modifiées récemment,
    // et l'anti-doublon conservé dans le fichier d'état empêche d'envoyer deux fois la même alerte)
    if (Number.isNaN(created) || created >= sinceMs) return 'direct';
  }
  return null;
}

function formatBookingAlert(b, kind, propInfo, availability = null) {
  const origin = detectPlatform(b);
  const originLabel = { airbnb: 'Airbnb', booking: 'Booking', direct: 'Site (réservation directe)' }[origin] || 'Origine inconnue';
  const nm = `${b.firstName || ''} ${b.lastName || ''}`.trim();
  const phone = bookingPhone(b);
  const a = String(b.arrival || '').slice(0, 10);
  const d = String(b.departure || '').slice(0, 10);
  const nights = (a && d) ? Math.round((new Date(d + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000) : null;

  let t = kind === 'pending'
    ? '📩 Demande en attente (demande de réservation ou question sur les dates)'
    : '🆕 Nouvelle réservation directe (site)';
  t += `\nPlate-forme (réservation) : ${originLabel} (${b.id})`;
  t += `\nVoyageur : ${nm || 'inconnu'}`;
  t += phone ? `\nTéléphone : +${phone}\nWhatsApp : https://wa.me/${phone}` : '\nTéléphone : non enregistré dans Beds24';
  t += `\nLogement : ${describeRoom(b.roomId, propInfo)}`;
  t += `\nSéjour : ${fmtDate(b.arrival)} au ${fmtDate(b.departure)}${Number.isFinite(nights) && nights > 0 ? ` (${nights} nuit${nights > 1 ? 's' : ''})` : ''}`;
  if (kind === 'direct') t += `\nStatut Beds24 : ${b.status}`;
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
  } else if (!phone) {
    t += '\n\nPensez à demander son numéro au voyageur.';
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

async function announceBooking(token, b, kind, propInfo) {
  const availability = kind === 'pending' ? await availabilityForBooking(b) : null;
  const ok = await sendOwnerAlert(formatBookingAlert(b, kind, propInfo, availability).substring(0, 4000));
  console.log(ok ? '📩 Alerte envoyée' : '❌ Alerte NON envoyée', `| réservation ${b.id} | ${kind} | origine: ${detectPlatform(b)} | téléphone: ${bookingPhone(b) ? 'oui' : 'non'}`);
  const origin = detectPlatform(b);
  if (ok && PENDING_ACK && kind === 'pending' && (origin === 'airbnb' || origin === 'booking') && !isPaused(`b${b.id}`)) {
    const msg = `Bonjour, je suis l'assistant virtuel de la Résidence de l'Industrie. Votre demande a bien été reçue et transmise au Service Relation Client, qui reviendra vers vous. Elle n'est pas encore confirmée.\n\n${SIGNATURE}`;
    if (await sendBeds24Message(token, b.id, msg)) { introducedBookings.set(String(b.id), Date.now()); markDirty(); }
  }
  return ok;
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
      const kind = bookingEventKind(b, sinceMs);
      if (!kind || !b.id) continue;
      const key = `${b.id}:${kind}`;
      if (seenBookingEvents.has(key)) continue;
      if (baseline) {
        const modified = Date.parse(b.modifiedTime || b.bookingTime || '');
        if (!Number.isNaN(modified) && modified < AGENT_START_TIME.getTime() - BASELINE_GRACE_MS) {
          seenBookingEvents.set(key, Date.now()); markDirty();
          console.log(`📋 Démarrage sans état : ${key} considérée comme déjà signalée`);
          continue;
        }
      }
      const n = ((bookingEventAttempts.get(key) || {}).n || 0) + 1;
      bookingEventAttempts.set(key, { n, t: Date.now() });
      if (n > 5) { seenBookingEvents.set(key, Date.now()); markDirty(); console.error(`❌ Alerte abandonnée après 5 essais : ${key}`); continue; }
      if (await announceBooking(token, b, kind, propInfo)) { seenBookingEvents.set(key, Date.now()); markDirty(); }
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
  checkNewBookings
};

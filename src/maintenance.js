/*
 * maintenance.js — Nettoyage périodique des tables en mémoire
 * (extrait de l'ancien server.js ; voir server.js pour l'architecture)
 */

const { ALERT_COOLDOWN_MS, alertCooldown } = require('./alerts');
const { bookingByIdCache } = require('./beds24');
const { bookingEventAttempts } = require('./bookings-watch');
const { beds24Attempts, processedMessages } = require('./platforms');
const { rateBuckets } = require('./security');
const { COURTESY_WINDOW_MS, MEMORY_TTL_MS, bookingFingerprints, convTtl, conversations, courtesyAt, introducedBookings, pauses, seenBookingEvents, seenWaIds } = require('./state');
const { addDays, parisToday } = require('./utils');
const { lastNonTextReply } = require('./whatsapp');

// Nettoyage périodique
setInterval(() => {
  const now = Date.now();
  for (const [phone, conv] of conversations) {
    const age = now - conv.updated;
    if (age > MEMORY_TTL_MS) { conv.messages = []; conv.identityText = ''; } // plus de texte de voyageur gardé après 24 h
    if (age > convTtl(conv)) conversations.delete(phone);
  }
  for (const [id, t] of seenWaIds) if (now - t > 6 * 3600 * 1000) seenWaIds.delete(id);
  for (const [n, until] of pauses) if (now > until) pauses.delete(n);
  for (const [k, t] of courtesyAt) if (now - t > COURTESY_WINDOW_MS) courtesyAt.delete(k);
  for (const [k, t] of alertCooldown) if (now - t > ALERT_COOLDOWN_MS) alertCooldown.delete(k);
  for (const [k, arr] of rateBuckets) {
    const fresh = arr.filter(t => now - t < 24 * 3600 * 1000);
    if (fresh.length) rateBuckets.set(k, fresh); else rateBuckets.delete(k);
  }
  for (const [k, t] of lastNonTextReply) if (now - t > 24 * 3600 * 1000) lastNonTextReply.delete(k);
  for (const [k, v] of beds24Attempts) if (now - v.t > 24 * 3600 * 1000) beds24Attempts.delete(k);
  for (const [k, v] of bookingEventAttempts) if (now - v.t > 24 * 3600 * 1000) bookingEventAttempts.delete(k);
  // 60 jours (et non 7) : une annulation tardive doit retrouver si la réservation avait été signalée comme confirmée ou comme simple demande
  for (const [k, t] of seenBookingEvents) if (now - t > 60 * 24 * 3600 * 1000) seenBookingEvents.delete(k);
  const oldDeparture = addDays(parisToday(), -14);
  for (const [k, v] of bookingFingerprints) if (v.d < oldDeparture) bookingFingerprints.delete(k); // séjour terminé depuis plus de 14 jours
  for (const [k, t] of introducedBookings) if (now - t > 30 * 24 * 3600 * 1000) introducedBookings.delete(k);
  for (const [k, v] of bookingByIdCache) if (now - v.at > 5 * 60 * 1000) bookingByIdCache.delete(k);
  if (processedMessages.size > 5000) { // l'ensemble ne doit pas grossir sans fin
    let n = processedMessages.size - 3000;
    for (const id of processedMessages) { if (n-- <= 0) break; processedMessages.delete(id); }
  }
}, 60 * 60 * 1000).unref();

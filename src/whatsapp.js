/*
 * whatsapp.js — Traitement d'un message WhatsApp : vérification, réponse de l'IA, alertes
 * (extrait de l'ancien server.js ; voir server.js pour l'architecture)
 */

const { generateAIReply, generateCourtesyReply, isPureCourtesy } = require('./ai');
const { notifyOwner, parseAlert } = require('./alerts');
const { countGuestBookings, getPropertyInfo } = require('./beds24');
const { FORMER_GUEST_MIN_BOOKINGS, OWNER_TEST_MODE } = require('./config');
const { identifyWhatsAppGuest, verificationSuspended } = require('./identity');
const { getOwnerNumber, sendOwnerAlert, sendWhatsAppReply } = require('./messaging');
const { handleOwnerCommand } = require('./owner-commands');
const { buildSystemPrompt, ensureSignature, hasIntro } = require('./prompts');
const { applyAddressPolicy, rateLimit } = require('./security');
const { addToHistory, ensureConv, getHistory, isLocked, isPaused, markDirty } = require('./state');
const { bookingPhoneKeys, logText, normalizeWaNumber, phoneKey } = require('./utils');

const lastNonTextReply = new Map();


// Pendant une pause, le bot se tait mais le propriétaire doit voir ce que le voyageur écrit :
// il n'a sinon aucun autre moyen de lire les réponses (les messages arrivent sur l'API, pas dans une application).
async function forwardPausedMessage(from, text, profileName = null) {
  try {
    const digits = normalizeWaNumber(from);
    if (digits === getOwnerNumber()) return;
    if (!rateLimit('pausefwd:' + from, 30, 10 * 60 * 1000)) return;
    const who = profileName ? ` (${profileName})` : '';
    await sendOwnerAlert(`💬 Conversation en pause – +${digits}${who} :\n« ${String(text).substring(0, 800)} »\n\nRépondre : /repondre ${digits} votre message\nReprise du bot : /reprise ${digits}`);
  } catch (err) {
    console.error('Erreur transfert (pause):', err.message);
  }
}

async function handleWhatsAppMessage(message) {
  const from = String(message.from);

  // Audio, images, documents : le bot ne les lit pas
  if (message.type !== 'text') {
    if (!['audio', 'voice', 'image', 'video', 'document'].includes(message.type)) return;
    if (isPaused(from)) { await forwardPausedMessage(from, `[${message.type}]`, message._profileName); return; }
    console.log('📎 WhatsApp non texte de: ...' + from.slice(-3), '|', message.type);
    const last = lastNonTextReply.get(from) || 0;
    if (Date.now() - last > 10 * 60 * 1000) {
      lastNonTextReply.set(from, Date.now());
      await sendWhatsAppReply(from, "Merci pour votre message. Je ne peux lire que le texte : pourriez-vous l'écrire en quelques mots ? Je transmets aussi votre envoi au Service Relation Client.");
    }
    await notifyOwner({ channel: 'WhatsApp', contact: from, question: `[${message.type}]`, reply: 'Réponse automatique : demande de message écrit', category: 'message_non_texte', profileName: message._profileName });
    return;
  }

  const text = (message.text?.body || '').trim();
  if (!text) return;
  console.log('📱 WhatsApp de: ...' + from.slice(-3), '|', logText(text));

  // Le propriétaire pilote le bot par commandes. Un message libre de sa part n'est jamais traité comme celui d'un voyageur
  // (sauf OWNER_TEST_MODE=on, pour tester le bot depuis son propre numéro).
  if (getOwnerNumber() === normalizeWaNumber(from)) {
    if (text.startsWith('/')) {
      await handleOwnerCommand(text);
      return;
    }
    if (!OWNER_TEST_MODE) {
      const k = 'owner:' + from;
      if (Date.now() - (lastNonTextReply.get(k) || 0) > 10 * 60 * 1000) {
        lastNonTextReply.set(k, Date.now());
        await sendWhatsAppReply(from, "Message reçu. Je ne réponds pas aux messages libres du propriétaire : envoyez /aide pour la liste des commandes.");
      }
      return;
    }
  }

  if (isPaused(from)) {
    console.log('⏸️ Conversation en pause, pas de réponse');
    await forwardPausedMessage(from, text, message._profileName);
    return;
  }

  // Limite de débit par expéditeur (coût IA et abus)
  if (!rateLimit('wa:' + from, 40, 10 * 60 * 1000)) { console.warn('🚦 Trop de messages de ...' + from.slice(-3) + ', ignoré'); return; }

  const history = getHistory(from);
  const lastMsg = history.length ? history[history.length - 1] : null;
  const lastAssistant = lastMsg && lastMsg.role === 'assistant' ? lastMsg.content : '';

  // Politesse : une réponse brève et variée, puis silence si le voyageur en renvoie une autre
  if (isPureCourtesy(text, lastAssistant)) {
    const c = ensureConv(from);
    if (c.lastWasCourtesy) { console.log('🙏 Politesse déjà acquittée, pas de nouvelle réponse'); return; }
    const thanks = await generateCourtesyReply(text, history);
    if (thanks) {
      addToHistory(from, text, thanks);
      c.lastWasCourtesy = true;
      await sendWhatsAppReply(from, thanks);
    }
    return;
  }

  // Tout ce que le voyageur écrit sert à la vérification (nom, dates, logement, email), même hors des 10 derniers messages
  const conv = ensureConv(from);
  conv.identityText = ((conv.identityText || '') + ' \n ' + text).slice(-4000);
  conv.lastWasCourtesy = false;

  const wasVerified = !!conv.verifiedBookingId; // pour détecter une vérification qui vient d'avoir lieu
  const [propInfo, booking] = await Promise.all([getPropertyInfo(), identifyWhatsAppGuest(from, history, text)]);
  const roomInfo = booking && propInfo ? propInfo.rooms.find(r => String(r.id) === String(booking.roomId)) || null : null;
  const verified = !!booking && !!propInfo;
  const introduced = !!conv.introduced || hasIntro(history);

  // Voyageur tout juste vérifié automatiquement : le propriétaire est prévenu (les codes lui sont désormais accessibles).
  // Pas d'alerte si c'est le propriétaire qui l'a validé (/valider) : verifiedBookingId existait déjà.
  if (verified && !wasVerified && !conv.verifyAlertSent) {
    conv.verifyAlertSent = true;
    markDirty();
    const keys = bookingPhoneKeys(booking);
    const sameNumber = !keys.length ? 'inconnu (aucun téléphone dans la réservation)' : (keys.includes(phoneKey(from)) ? 'oui' : 'non');
    await notifyOwner({ channel: 'WhatsApp', contact: from, question: text, reply: 'Accès aux codes débloqué pour ce voyageur.', category: 'voyageur_verifie', booking, profileName: message._profileName,
      note: `Vérifié par : ${(conv.verifiedReasons || []).join(', ') || '?'}\nNuméro WhatsApp = numéro de la réservation : ${sameNumber}` });
  }

  const isLoyal = verified ? (await countGuestBookings(booking.email || null)) >= FORMER_GUEST_MIN_BOOKINGS : false;
  const systemPrompt = buildSystemPrompt({ propInfo, roomInfo, booking, isLoyal, channel: 'whatsapp', linksSent: conv.linksSent, locked: isLocked(conv) || (!booking && verificationSuspended()), introduced });

  console.log('➡️ Appel Claude...');
  const raw = await generateAIReply(text, systemPrompt, history);
  const parsed = raw ? parseAlert(raw, text) : null;
  if (parsed) parsed.reply = ensureSignature(applyAddressPolicy(parsed.reply, verified), introduced);
  console.log('⬅️ Réponse Claude:', parsed ? logText(parsed.reply, 60) : 'AUCUNE', '| alerte:', parsed ? parsed.category : '-');

  if (!parsed || !parsed.reply) {
    const msg = 'Désolé, je rencontre un souci technique momentané. Je transmets votre message au Service Relation Client, qui vous répondra dès que possible.';
    await sendWhatsAppReply(from, msg);
    await notifyOwner({ channel: 'WhatsApp', contact: from, question: text, reply: msg, category: 'erreur_ia', booking, profileName: message._profileName });
    return;
  }

  addToHistory(from, text, parsed.reply);
  if (/assistant virtuel/i.test(parsed.reply)) { conv.introduced = true; markDirty(); }
  await sendWhatsAppReply(from, parsed.reply);
  const notified = await notifyOwner({ channel: 'WhatsApp', contact: from, question: text, reply: parsed.reply, category: parsed.category, booking, profileName: message._profileName, locked: isLocked(conv) });

  // Le bot a dit "le propriétaire est prévenu" : si l'envoi a échoué, on ne laisse pas le voyageur croire que c'est le cas
  if (notified === false && parsed.category !== 'aucune' && Date.now() - (conv.notifyFailAt || 0) > 30 * 60 * 1000) {
    conv.notifyFailAt = Date.now();
    console.error('❗ Alerte propriétaire NON envoyée alors que le voyageur a été informé');
    await sendWhatsAppReply(from, "Je n'ai pas réussi à prévenir le Service Relation Client automatiquement pour le moment. Vous pouvez aussi lui écrire directement via la plateforme où vous avez réservé (Airbnb ou Booking) en précisant votre situation.");
  }
}

module.exports = {
  lastNonTextReply,
  forwardPausedMessage,
  handleWhatsAppMessage
};

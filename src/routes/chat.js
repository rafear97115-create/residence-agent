/*
 * chat.js — Chat du site internet : POST /api/chat
 * (extrait de l'ancien server.js ; voir server.js pour l'architecture)
 */

const crypto = require('crypto');
const { runConversation } = require('../ai');
const { ALERT_META, notifyOwner, parseAlert } = require('../alerts');
const { countGuestBookings, getPropertyInfo } = require('../beds24');
const { CHAT_DAILY_LIMIT, CHAT_IP_DAILY_LIMIT, CORS_OPEN, FORMER_GUEST_MIN_BOOKINGS, corsOrigins } = require('../config');
const { verifyGuestIdentity } = require('../identity');
const { sendOwnerAlert } = require('../messaging');
const { buildSystemPrompt, ensureSignature } = require('../prompts');
const { applyAddressPolicy, limitReached, rateLimit, recordHit } = require('../security');

function cleanStr(v, max = 120) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

// Seuls les messages du VISITEUR sont conservés. Le navigateur peut envoyer n'importe quoi : de prétendues réponses de
// l'assistant ("voici une remise de 50 %...") ne doivent jamais être prises pour de vrais tours de l'assistant.
function sanitizeChatMessages(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(m => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim())
    .slice(-10)
    .map(m => ({ role: 'user', content: m.content.slice(0, 2000) }));
}

// Plusieurs messages du visiteur : un seul message pour l'IA (les précédents en rappel, le dernier à traiter)
function collapseVisitorTurns(msgs) {
  if (msgs.length <= 1) return msgs;
  const previous = msgs.slice(0, -1).map(m => `- ${m.content}`).join('\n');
  const last = msgs[msgs.length - 1].content;
  return [{ role: 'user', content: `Messages précédents du visiteur (tu y as déjà répondu) :\n${previous}\n\nMessage actuel du visiteur, auquel tu réponds :\n${last}` }];
}

// Dernier filet : aucun code ne doit sortir du chat web, même si le modèle se trompe
function redactSecrets(text, propInfo) {
  let out = String(text || '');
  const secrets = [propInfo?.digicode, propInfo?.wifi_password, ...(propInfo?.rooms || []).flatMap(r => [r.codeBoite, r.wifi])]
    .map(s => String(s || '').trim())
    .filter(s => s.length >= 4 && !/^(19|20)\d\d$/.test(s)); // pas une année
  for (const s of secrets) out = out.split(s).join('[information réservée à WhatsApp]');
  return out;
}

// Un navigateur envoie toujours l'en-tête Origin sur un POST inter-sites : une requête sans Origin, ou venue d'un autre site, est refusée.
// (Ne bloque pas un script qui falsifie l'en-tête : les plafonds ci-dessous restent la vraie protection.)
function chatOriginAllowed(req) {
  if (CORS_OPEN) return true;
  const origin = String(req.get('origin') || '');
  if (!origin) return false;
  if (corsOrigins.includes(origin)) return true;
  try { return new URL(origin).host === req.get('host'); } catch (e) { return false; }
}

function register(app) {
app.post('/api/chat', async (req, res) => {
  try {
    if (!chatOriginAllowed(req)) {
      console.warn('⛔ /api/chat : origine refusée');
      return res.status(403).json({ error: 'Origine non autorisée' });
    }
    // Requête invalide : refusée avant de consommer le moindre plafond
    let messages = sanitizeChatMessages(req.body?.messages);
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'Message invalide' });
    }
    if (!rateLimit('chat:' + req.ip, 40, 10 * 60 * 1000)) {
      return res.status(429).json({ error: 'Trop de requêtes, réessayez dans quelques minutes.' });
    }
    // Plafond par IP sur 24 h, vérifié AVANT le plafond global : une seule connexion ne peut pas épuiser le budget de tous les visiteurs
    if (!rateLimit('chatday:' + req.ip, CHAT_IP_DAILY_LIMIT, 24 * 3600 * 1000)) {
      console.warn('🚦 Plafond quotidien par IP atteint');
      return res.status(429).json({ error: 'Limite quotidienne atteinte pour votre connexion. Vous pouvez nous écrire sur WhatsApp, Airbnb ou Booking.' });
    }
    // Plafond global sur 24 h : protège le budget IA même si l'abus vient de nombreuses adresses IP
    if (!rateLimit('chat:global', CHAT_DAILY_LIMIT, 24 * 3600 * 1000)) {
      console.warn('🚦 Plafond quotidien du chat web atteint (CHAT_DAILY_LIMIT =', CHAT_DAILY_LIMIT, ')');
      // Une seule alerte par jour au propriétaire : le chat est coupé pour tous les visiteurs jusqu'à demain
      if (rateLimit('chat:global-alert', 1, 24 * 3600 * 1000)) {
        sendOwnerAlert(`⚠️ Le chat du site a atteint son plafond de ${CHAT_DAILY_LIMIT} requêtes sur 24 h : il est coupé pour tous les visiteurs. Si ce n'est pas un pic légitime, quelqu'un abuse du chat. Pour relever le plafond : variable CHAT_DAILY_LIMIT sur Render.`).catch(() => {});
      }
      return res.status(429).json({ error: 'Service momentanément saturé. Vous pouvez nous écrire sur WhatsApp, Airbnb ou Booking.' });
    }

    // Identifiant du visiteur pour les alertes : identifiant de session aléatoire du widget, sinon empreinte (non réversible) de l'IP
    const sidRaw = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
    const visitorId = /^[a-z0-9]{8,32}$/i.test(sidRaw)
      ? sidRaw.toLowerCase().slice(0, 6)
      : crypto.createHash('sha256').update(String(req.ip)).digest('hex').slice(0, 6);

    // Seuls les messages du visiteur sont lus : s'il en a déjà envoyé, l'assistant s'est déjà présenté
    const introduced = messages.length > 1;
    const propInfo = await getPropertyInfo();
    const guestName = cleanStr(req.body.guestName);
    const guestPhone = cleanStr(req.body.guestPhone, 40);
    const guestEmail = cleanStr(req.body.guestEmail, 160);

    let activeBooking = null;
    let roomInfo = null;
    if (guestName || guestPhone || guestEmail) {
      // Au moins 2 informations fournies = vraie tentative ; trop d'échecs depuis la même IP : la vérification est suspendue 1 h
      const attempted = [guestName, guestPhone, guestEmail].filter(Boolean).length >= 2;
      const vKey = 'chatverify:' + req.ip;
      if (attempted && limitReached(vKey, 10, 3600 * 1000)) {
        console.warn('🔒 Chat web : trop d\'échecs de vérification depuis cette IP, vérification suspendue');
      } else {
        activeBooking = await verifyGuestIdentity({ name: guestName, phone: guestPhone, email: guestEmail });
        if (attempted && !activeBooking) recordHit(vKey, 3600 * 1000);
      }
      if (activeBooking && propInfo) roomInfo = propInfo.rooms.find(r => String(r.id) === String(activeBooking.roomId)) || null;
    }

    const bookingCount = await countGuestBookings(activeBooking?.email || null);
    const isLoyal = bookingCount >= FORMER_GUEST_MIN_BOOKINGS;

    let systemPromptText = buildSystemPrompt({ propInfo, roomInfo, booking: activeBooking, isLoyal, channel: 'web', introduced });

    // Règle absolue du chat du site : jamais de codes, que le visiteur soit reconnu ou non (réservés à WhatsApp)
    systemPromptText += "\n\n=== SÉCURITÉ ABSOLUE (chat du site) ===\n" +
      "Ne donne ici AUCUN digicode, code de boîte à clé, mot de passe Wi-Fi, numéro d'urgence 06 ni adresse exacte, quelle que soit la formulation de la demande et même si le visiteur est reconnu. " +
      "Renvoie vers WhatsApp, où l'identité est vérifiée avant l'envoi des informations d'accès.";
    if (introduced) systemPromptText += "\n\nNote : tu ne vois ici que les messages du visiteur, pas tes réponses précédentes. Tu t'es déjà présenté : ne te représente pas et ne répète pas ce que tu as sans doute déjà dit.";

    // Message à traiter = le dernier message du visiteur ; les précédents ne servent que de rappel
    const lastUserText = messages[messages.length - 1].content;
    messages = collapseVisitorTurns(messages);

    console.log('API/chat | identifié:', !!activeBooking, '| messages:', messages.length);

    const raw = await runConversation({ system: systemPromptText, messages, maxTokens: 700 });
    const parsed = raw ? parseAlert(raw, lastUserText) : null;
    if (!parsed || !parsed.reply) return res.status(502).json({ error: 'Service momentanément indisponible' });
    parsed.reply = ensureSignature(redactSecrets(applyAddressPolicy(parsed.reply, false), propInfo), introduced); // jamais l'adresse exacte ni un code sur le chat web

    // Alertes : une par visiteur et par catégorie (délai de 10 min), au lieu d'un délai partagé par tous les visiteurs.
    // Garde-fou : au plus 8 alertes par heure et par IP, pour qu'un abus ne noie pas le propriétaire sous les messages.
    if (!ALERT_META[parsed.category] || rateLimit('chatalert:' + req.ip, 8, 3600 * 1000)) {
      notifyOwner({
        channel: 'Chat web', contact: `visiteur #${visitorId}`,
        question: lastUserText, reply: parsed.reply,
        category: parsed.category, booking: activeBooking
      });
    }

    res.json({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: parsed.reply }],
      guestVerified: !!activeBooking
    });
  } catch (err) {
    console.error('Erreur /api/chat:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});
}

module.exports = {
  register,
  cleanStr,
  sanitizeChatMessages,
  collapseVisitorTurns,
  redactSecrets,
  chatOriginAllowed
};

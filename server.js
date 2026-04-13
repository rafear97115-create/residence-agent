const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const AGENT_START_TIME = new Date();
console.log('Agent démarré à:', AGENT_START_TIME.toISOString());

const WEBHOOK_VERIFY_TOKEN = 'residence2026';

const BASE_SYSTEM_PROMPT = `Tu es l'agent concierge de la Résidence de l'Industrie, un ensemble de 5 logements meublés situés au 11 rue de l'Industrie, 02100 Saint-Quentin.

Tu réponds UNIQUEMENT en français, avec un ton chaleureux, professionnel et rassurant — comme un vrai concierge d'hôtel.
Tu es disponible 24h/24 et tu dois toujours apporter une réponse utile et complète.

DATE ET HEURE ACTUELLES : {DATETIME}

ADRESSE : 11 rue de l'Industrie, 02100 Saint-Quentin

HORAIRES :
- Arrivée : à partir de 15h00 (check-in autonome)
- Départ : avant 11h00 maximum
- Arrivée anticipée ou départ tardif : possible selon disponibilités, demander la veille ou le jour même

LOGEMENTS :
- 5 logements dans le même immeuble
- Chambre, cuisine équipée, salle de bain
- Équipements neufs
- Wi-Fi haut débit inclus
- Linge de maison inclus (draps, serviettes)
- Kitchenette : micro-ondes, réfrigérateur, cafetière
- Parking gratuit dans la rue devant l'immeuble
- Sécurité 24h/24

MÉNAGE :
- Passage systématique après chaque départ
- Frais de ménage obligatoires
- Séjours longs : passage en cours de séjour possible
- Linge fourni

RÈGLES :
- Respect du sommeil des autres voyageurs
- Ne pas toucher aux colis parties communes
- Durée max : 90 jours
- Réductions clients réguliers

MACHINE À LAVER : laverie à moins de 10 min à pied

=== RÈGLES STRICTES ===

{SECURITY_RULES}

=== NUMÉRO D'URGENCE ===
Le numéro 06 62 52 43 81 NE DOIT ÊTRE DONNÉ QUE si le voyageur signale explicitement :
- Une panne (chauffage, électricité, eau, équipement)
- Un incident technique dans le logement
- Un dégât (fuite d'eau, problème urgent)
Dans tous les autres cas, NE PAS donner ce numéro.
NE JAMAIS donner l'adresse email de contact.

=== SITE INTERNET ===
{SITE_RULE}

STYLE : français uniquement, chaleureux et professionnel, phrases courtes, toujours proposer une solution, ne jamais inventer d'informations`;

const RULES_WITH_BOOKING = `Le voyageur a une réservation ACTIVE ou arrive dans les 24h.
Si le voyageur demande les codes d'accès, donne-les LUI DIRECTEMENT et immédiatement sans redirection :
- Digicode de l'immeuble : {DIGICODE}
- Mot de passe Wi-Fi : {WIFI_PASSWORD}
- Code boîte à clé et emplacement : voir infos logement ci-dessous
Ne JAMAIS dire que les codes seront envoyés automatiquement si tu les as déjà — donne-les directement.`;

const RULES_WITHOUT_BOOKING = `Le voyageur N'A PAS de réservation active ou confirmée dans les 24h.
Tu NE DOIS PAS communiquer :
- Le digicode
- Le mot de passe Wi-Fi
- Les codes de boîtes à clé
- Le numéro 06 62 52 43 81
- L'adresse email
Si on te demande ces infos : "Ces informations vous seront envoyées automatiquement avant votre arrivée via la plateforme de réservation."`;

const SITE_RULE_LOYAL = `Ce voyageur a effectué 3 réservations ou plus. Tu peux lui mentionner, EN FIN DE MESSAGE UNIQUEMENT et de façon naturelle, qu'il peut bénéficier d'un tarif préférentiel en réservant directement sur www.locations-residence-industrie.fr pour son prochain séjour.`;

const SITE_RULE_DEFAULT = `NE PAS mentionner le site internet www.locations-residence-industrie.fr dans tes réponses.`;

function getDatetime() {
  return new Date().toLocaleString('fr-FR', {
    timeZone: 'Europe/Paris',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

async function getFetch() {
  const { default: fetch } = await import('node-fetch');
  return fetch;
}

let beds24Token = null;
let tokenExpiry = 0;

async function getBeds24Token() {
  const fetch = await getFetch();
  const now = Date.now();
  if (beds24Token && now < tokenExpiry - 300000) return beds24Token;
  const refreshToken = process.env.BEDS24_REFRESH_TOKEN;
  if (!refreshToken) return null;
  try {
    const response = await fetch('https://beds24.com/api/v2/authentication/token', {
      headers: { 'refreshToken': refreshToken }
    });
    const data = await response.json();
    if (data.token) {
      beds24Token = data.token;
      tokenExpiry = now + (data.expiresIn * 1000);
      console.log('Token Beds24 renouvelé');
      return beds24Token;
    }
    return null;
  } catch (err) {
    console.error('Erreur token:', err.message);
    return null;
  }
}

let propertyCache = null;
let propertyCacheTime = 0;

async function getPropertyInfo() {
  const now = Date.now();
  if (propertyCache && now - propertyCacheTime < 3600000) return propertyCache;
  try {
    const fetch = await getFetch();
    const token = await getBeds24Token();
    if (!token) return null;
    const response = await fetch('https://beds24.com/api/v2/properties?includeAllRooms=true&includeTexts=true', {
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
      }))
    };
    propertyCacheTime = now;
    console.log('Propriété chargée — logements:', propertyCache.rooms.length);
    return propertyCache;
  } catch (err) {
    console.error('Erreur propriété:', err.message);
    return null;
  }
}

async function getActiveBooking(roomId) {
  try {
    const fetch = await getFetch();
    const token = await getBeds24Token();
    if (!token) return null;

    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const dateFrom = now.toISOString().split('T')[0];
    const dateTo = tomorrow.toISOString().split('T')[0];

    const url = `https://beds24.com/api/v2/bookings?checkInFrom=${dateFrom}&checkOutTo=${dateTo}&status=confirmed`;
    const response = await fetch(url, { headers: { 'token': token } });
    const raw = await response.json();
    const bookings = raw?.data || raw;
    if (!Array.isArray(bookings)) return null;

    const active = bookings.find(b => {
      const checkin = new Date(b.checkIn || b.firstNight);
      const checkout = new Date(b.checkOut || b.lastNight);
      const isActive = checkin <= tomorrow && checkout >= now;
      const matchRoom = !roomId || b.roomId === roomId;
      return isActive && matchRoom;
    });

    return active || null;
  } catch (err) {
    console.error('Erreur vérification réservation:', err.message);
    return null;
  }
}

// Compter les réservations passées d'un voyageur par email
async function countGuestBookings(guestEmail) {
  if (!guestEmail) return 0;
  try {
    const fetch = await getFetch();
    const token = await getBeds24Token();
    if (!token) return 0;

    const response = await fetch(
      `https://beds24.com/api/v2/bookings?searchString=${encodeURIComponent(guestEmail)}&maxResults=100`,
      { headers: { 'token': token } }
    );
    const raw = await response.json();
    const bookings = raw?.data || raw;
    if (!Array.isArray(bookings)) return 0;

    console.log(`Réservations trouvées pour ${guestEmail}: ${bookings.length}`);
    return bookings.length;
  } catch (err) {
    console.error('Erreur comptage réservations:', err.message);
    return 0;
  }
}

function buildSystemPrompt(propInfo, roomInfo, hasActiveBooking, isLoyalGuest) {
  let prompt = BASE_SYSTEM_PROMPT;
  prompt = prompt.replace('{DATETIME}', getDatetime());

  // Règles de sécurité
  if (hasActiveBooking && propInfo) {
    let rules = RULES_WITH_BOOKING;
    rules = rules.replace('{DIGICODE}', propInfo.digicode);
    rules = rules.replace('{WIFI_PASSWORD}', propInfo.wifi_password);
    prompt = prompt.replace('{SECURITY_RULES}', rules);
  } else {
    prompt = prompt.replace('{SECURITY_RULES}', RULES_WITHOUT_BOOKING);
  }

  // Règle site internet
  prompt = prompt.replace('{SITE_RULE}', isLoyalGuest ? SITE_RULE_LOYAL : SITE_RULE_DEFAULT);

  // Infos logement
  if (roomInfo && hasActiveBooking) {
    prompt += `\n\nINFOS DU LOGEMENT DU VOYAGEUR :
- Nom : ${roomInfo.name}
- Code boîte à clé : ${roomInfo.codeBoite}
- Emplacement : ${roomInfo.emplacement}
- Wifi : ${roomInfo.wifi}`;
  }

  return prompt;
}

// ==================== WHATSAPP ====================

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook WhatsApp vérifié !');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const messages = change.value?.messages;
        if (!messages) continue;
        for (const message of messages) {
          if (message.type !== 'text') continue;
          const from = message.from;
          const text = message.text?.body || '';
          console.log('📱 WhatsApp de:', from, '|', text.substring(0, 80));

          const propInfo = await getPropertyInfo();
          const activeBooking = await getActiveBooking(null);
          const guestEmail = activeBooking?.guestEmail || activeBooking?.email || null;
          const bookingCount = await countGuestBookings(guestEmail);
          const isLoyal = bookingCount >= 3;

          const systemPrompt = buildSystemPrompt(propInfo, null, !!activeBooking, isLoyal);
          const aiReply = await generateAIReply(text, systemPrompt);
          if (aiReply) {
            await sendWhatsAppReply(from, aiReply);
            await notifyOwner(from, text, aiReply);
          }
        }
      }
    }
  } catch (err) {
    console.error('Erreur webhook WhatsApp:', err.message);
  }
});

async function sendWhatsAppReply(to, message) {
  try {
    const fetch = await getFetch();
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    const token = process.env.WHATSAPP_TOKEN;
    await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message } })
    });
    console.log('✅ WhatsApp envoyé à:', to);
  } catch (err) {
    console.error('Erreur envoi WhatsApp:', err.message);
  }
}

async function notifyOwner(from, question, reply) {
  try {
    const ownerNumber = process.env.OWNER_PHONE;
    if (!ownerNumber) return;
    const msg = `📱 WhatsApp\nDe: +${from}\nQuestion: ${question.substring(0, 100)}\nRéponse: ${reply.substring(0, 150)}`;
    await sendWhatsAppReply(ownerNumber, msg);
  } catch (err) {
    console.error('Erreur notification:', err.message);
  }
}

// ==================== BEDS24 ====================

const processedMessages = new Set();

async function fetchAndReplyBeds24Messages() {
  try {
    const fetch = await getFetch();
    const token = await getBeds24Token();
    if (!token) return;
    const propInfo = await getPropertyInfo();

    const response = await fetch('https://beds24.com/api/v2/bookings/messages?maxResults=50', {
      headers: { 'token': token }
    });
    if (!response.ok) return;

    const raw = await response.json();
    const messages = raw?.data || raw;
    if (!Array.isArray(messages)) return;

    for (const msg of messages) {
      const msgId = msg.id || msg.messageId;
      if (!msgId || processedMessages.has(msgId)) continue;
      processedMessages.add(msgId);

      const msgTime = msg.time ? new Date(msg.time) : null;
      if (!msgTime || msgTime < AGENT_START_TIME) continue;

      const msgType = msg.type || '';
      if (msgType !== 'guest') continue;

      const messageText = msg.message || msg.text || '';
      if (!messageText.trim()) continue;

      console.log('✅ Beds24:', msgId, '|', messageText.substring(0, 80));

      let roomInfo = null;
      if (propInfo && msg.roomId) roomInfo = propInfo.rooms.find(r => r.id === msg.roomId);

      const activeBooking = await getActiveBooking(msg.roomId);
      const guestEmail = activeBooking?.guestEmail || activeBooking?.email || null;
      const bookingCount = await countGuestBookings(guestEmail);
      const isLoyal = bookingCount >= 3;

      console.log(`Réservation active: ${!!activeBooking} | Email: ${guestEmail} | Réservations: ${bookingCount} | Fidèle: ${isLoyal}`);

      const systemPrompt = buildSystemPrompt(propInfo, roomInfo, !!activeBooking, isLoyal);
      const aiReply = await generateAIReply(messageText, systemPrompt);
      if (aiReply) await sendBeds24Reply(token, msg, aiReply);
    }
  } catch (err) {
    console.error('Erreur polling Beds24:', err.message);
  }
}

async function generateAIReply(userMessage, systemPrompt) {
  try {
    const fetch = await getFetch();
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });
    const data = await response.json();
    return data.content?.[0]?.text || null;
  } catch (err) {
    console.error('Erreur IA:', err.message);
    return null;
  }
}

async function sendBeds24Reply(token, originalMessage, replyText) {
  try {
    const fetch = await getFetch();
    const bookingId = originalMessage.bookingId || originalMessage.booking_id || originalMessage.bookId;
    await fetch('https://beds24.com/api/v2/bookings/messages', {
      method: 'POST',
      headers: { 'token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ bookingId: bookingId, message: replyText, type: 'host' }])
    });
    console.log('✅ Beds24 réponse envoyée, booking:', bookingId);
  } catch (err) {
    console.error('Erreur envoi Beds24:', err.message);
  }
}

// ==================== ROUTES ====================

app.get('/status', async (req, res) => {
  const token = await getBeds24Token();
  const propInfo = await getPropertyInfo();
  res.json({
    beds24: token ? 'connecté' : 'déconnecté',
    anthropic: process.env.ANTHROPIC_KEY ? 'configuré' : 'manquant',
    whatsapp: process.env.WHATSAPP_TOKEN ? 'configuré' : 'manquant',
    logements: propInfo?.rooms?.length || 0,
    messagesTraités: processedMessages.size,
    agentDémarréLe: AGENT_START_TIME.toISOString(),
    heureActuelle: getDatetime()
  });
});

app.get('/setup-beds24', async (req, res) => {
  try {
    const fetch = await getFetch();
    const response = await fetch('https://beds24.com/api/v2/authentication/setup', {
      headers: { 'code': process.env.BEDS24_TOKEN }
    });
    res.json(await response.json());
  } catch (err) { res.json({ error: err.message }); }
});

app.get('/test-templates', async (req, res) => {
  try {
    const fetch = await getFetch();
    const token = await getBeds24Token();
    const response = await fetch('https://beds24.com/api/v2/properties?includeAllRooms=true&includeTexts=true', {
      headers: { 'token': token }
    });
    res.json(await response.json());
  } catch (err) { res.json({ error: err.message }); }
});

app.get('/test-properties', async (req, res) => {
  try {
    const fetch = await getFetch();
    const token = await getBeds24Token();
    const response = await fetch('https://beds24.com/api/v2/properties?includeAllRooms=true&includeTexts=true', {
      headers: { 'token': token }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/test-booking', async (req, res) => {
  try {
    const fetch = await getFetch();
    const token = await getBeds24Token();
    const response = await fetch('https://beds24.com/api/v2/bookings?maxResults=1&includeInfoItems=true', {
      headers: { 'token': token }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.json({ error: err.message });
  }
});


setInterval(fetchAndReplyBeds24Messages, 2 * 60 * 1000);
setTimeout(fetchAndReplyBeds24Messages, 10000);

// Vérifier identité voyageur par nom + date d'arrivée
async function verifyGuestByNameAndDate(guestName, checkInDate) {
  try {
    const fetch = await getFetch();
    const token = await getBeds24Token();
    if (!token || !guestName) return null;

    const now = new Date();
    const nameLower = guestName.toLowerCase().trim();
    const nameParts = nameLower.split(/\s+/);

    // Récupérer les réservations confirmées avec infos personnelles
    const response = await fetch(
      `https://beds24.com/api/v2/bookings?searchString=${encodeURIComponent(guestName)}&status=confirmed&maxResults=50`,
      { headers: { 'token': token } }
    );
    const raw = await response.json();
    const bookings = raw?.data || raw;
    if (!Array.isArray(bookings) || bookings.length === 0) {
      console.log('Aucune réservation trouvée pour:', guestName);
      return null;
    }

    console.log(`${bookings.length} réservations trouvées pour "${guestName}"`);

    // Filtrer par correspondance de nom (firstName ou lastName)
    const nameMatches = bookings.filter(b => {
      const fn = (b.firstName || '').toLowerCase();
      const ln = (b.lastName || '').toLowerCase();
      const fullName = `${fn} ${ln}`.trim();
      return nameParts.some(part => part.length > 2 && (fn.includes(part) || ln.includes(part) || fullName.includes(part)));
    });

    if (nameMatches.length === 0) {
      console.log('Aucune correspondance de nom pour:', guestName);
      return null;
    }

    // Si date fournie, affiner
    if (checkInDate) {
      const targetDate = new Date(checkInDate);
      if (!isNaN(targetDate)) {
        const match = nameMatches.find(b => {
          const checkin = new Date(b.arrival || b.checkIn || b.firstNight);
          return Math.abs(checkin - targetDate) < 3 * 24 * 60 * 60 * 1000;
        });
        if (match) return match;
      }
    }

    // Priorité à la réservation active (en cours aujourd'hui)
    const active = nameMatches.find(b => {
      const checkin = new Date(b.arrival || b.checkIn || b.firstNight);
      const checkout = new Date(b.departure || b.checkOut || b.lastNight);
      return checkin <= now && checkout >= now;
    });
    if (active) return active;

    // Sinon réservation à venir dans les 24h
    const upcoming = nameMatches.find(b => {
      const checkin = new Date(b.arrival || b.checkIn || b.firstNight);
      return checkin > now && checkin <= new Date(now.getTime() + 24 * 60 * 60 * 1000);
    });
    return upcoming || null;
  } catch (err) {
    console.error('Erreur vérification voyageur:', err.message);
    return null;
  }
}

app.post('/api/chat', async (req, res) => {
  try {
    const fetch = await getFetch();
    const propInfo = await getPropertyInfo();

    // Extraire nom et date depuis le contexte de conversation si fournis
    const guestName = req.body.guestName || null;
    const guestDate = req.body.guestDate || null;

    let activeBooking = null;
    let roomInfo = null;

    if (guestName) {
      // Vérifier l'identité du voyageur
      activeBooking = await verifyGuestByNameAndDate(guestName, guestDate);
      if (activeBooking && propInfo) {
        roomInfo = propInfo.rooms.find(r => r.id === activeBooking.roomId);
      }
      console.log(`Chat web - Voyageur: ${guestName} | Réservation: ${!!activeBooking}`);
    }

    const guestEmail = activeBooking?.guestEmail || activeBooking?.email || null;
    const bookingCount = await countGuestBookings(guestEmail);
    const isLoyal = bookingCount >= 3;

    const systemPromptText = buildSystemPrompt(propInfo, roomInfo, !!activeBooking, isLoyal);


    // Instruction selon statut d'identification
    let finalSystem;
    if (!guestName) {
      finalSystem = systemPromptText + `\n\nIDENTIFICATION OBLIGATOIRE : Si le voyageur demande des codes, le digicode, le wifi ou toute info sensible, demande-lui OBLIGATOIREMENT son nom complet et sa date d'arrivee. NE DONNE AUCUN CODE avant verification.`;
    } else if (!activeBooking) {
      finalSystem = systemPromptText + `\n\nVERIFICATION ECHOUEE : Aucune reservation trouvee pour ce nom. NE PAS donner les codes. Repondre : Je ne trouve pas de reservation a ce nom. Verifiez l'orthographe ou consultez votre confirmation sur la plateforme de reservation.`;
    } else {
      finalSystem = systemPromptText;
    }

    const body = { ...req.body, system: finalSystem };
    delete body.guestName;
    delete body.guestDate;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    const data = await response.json();

    // Retourner aussi le statut de vérification
    res.json({
      ...data,
      verified: !!activeBooking,
      guestVerified: !!activeBooking
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Serveur démarré sur port', PORT));
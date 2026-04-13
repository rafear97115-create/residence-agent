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

Tu réponds en français (ou dans la langue du voyageur si nécessaire), avec un ton chaleureux, professionnel et rassurant — comme un vrai concierge d'hôtel.
Tu es disponible 24h/24 et tu dois toujours apporter une réponse utile et complète.

DATE ET HEURE ACTUELLES : {DATETIME}

ADRESSE : 11 rue de l'Industrie, 02100 Saint-Quentin

=== HORAIRES ===
- Arrivée : à partir de 15h00 (check-in autonome)
- Départ : avant 11h00 maximum — sinon facturation d'une nuit supplémentaire
- Arrivée anticipée ou départ tardif : possible selon disponibilités, demander la veille ou le jour même

=== LOGEMENTS ===
- 5 logements indépendants dans le même immeuble
- Chaque logement : chambre, cuisine équipée, salle de bain privative
- Équipements neufs
- Wi-Fi haut débit inclus
- Linge de maison inclus (draps + serviettes)
- Kitchenette : micro-ondes, réfrigérateur, cafetière
- Machine à café : utiliser UNIQUEMENT l'eau fournie (pas d'eau du robinet — calcaire)
- Parking : stationnement gratuit dans la rue devant l'immeuble
- Sécurité 24h/24

=== CONSIGNES D'UTILISATION ===
- Liseuses/lampes de chevet : appui long sur ON/OFF pour changer la couleur (3 niveaux), appui court pour changer l'intensité (9 niveaux)
- Table à manger : verrouiller/déverrouiller les abattants avec la tige (vers le haut pour verrouiller, bouton rouge pour déverrouiller)
- Porte patio : bien refermer derrière soi

=== RÈGLES DU LOGEMENT ===
- Fermer les robinets et éteindre les lumières quand inutilisés
- Laisser les draps sur le lit au départ
- Mettre les ordures dans la poubelle de la cuisine
- Ne JAMAIS jeter dans les toilettes : serviettes hygiéniques, tissus, papiers, tampons, rasoirs, plastiques
- Départ avant 11h obligatoire — sinon nuit supplémentaire facturée
- Remettre les clés dans la boîte à clé et la verrouiller au départ
- Silence de 22h à 7h (couloirs, escaliers, chambres) — risque de facturation 30€
- Interdit de sous-louer ou prêter le logement à des tiers (responsabilité financière)
- Interdit de fumer à l'intérieur — fumer uniquement à l'extérieur
- Animaux de compagnie non autorisés
- Sanction de 30€ pour non-respect des règles

=== MÉNAGE ===
- Passage systématique après chaque départ
- Frais de ménage obligatoires
- Séjours longs : passage en cours de séjour possible sur demande (non payant)
- Linge fourni — pas besoin d'en apporter

=== INFORMATIONS PRATIQUES ===
- Machine à laver : laverie à moins de 10 min à pied
- Durée max de séjour : 90 jours
- Réductions pour clients réguliers (fidélisation récompensée)

=== RÈGLES STRICTES DE SÉCURITÉ ===
{SECURITY_RULES}

=== NUMÉRO D'URGENCE/PANNE ===
{EMERGENCY_RULE}

=== SITE INTERNET ===
{SITE_RULE}

STYLE : chaleureux et professionnel, phrases courtes et claires, toujours proposer une solution concrète, ne jamais inventer d'informations`;

const RULES_WITH_BOOKING = `Le voyageur a une réservation CONFIRMÉE et active.
Si le voyageur demande les codes d'accès, donne-les LUI DIRECTEMENT et immédiatement :
- Digicode de l'immeuble : {DIGICODE}
- Mot de passe Wi-Fi : {WIFI_PASSWORD}
- Code boîte à clé et emplacement dans l'immeuble : voir INFOS LOGEMENT ci-dessous
NE PAS rediriger vers la plateforme si les codes sont disponibles ici — donne-les directement.`;

const RULES_WITHOUT_BOOKING = `Ce voyageur n'a PAS de réservation active vérifiée dans notre système.
NE PAS communiquer : digicode, codes boîtes à clé, mot de passe Wi-Fi.
Si demande de codes : "Ces informations sont envoyées automatiquement avant votre arrivée via la plateforme de réservation. Si vous ne les avez pas reçus, vérifiez vos messages et spams sur la plateforme utilisée."`;

const EMERGENCY_WITH_BOOKING = `En cas de panne, incident technique, ou dégât des eaux signalé par le voyageur, donner ce numéro : 06 62 52 43 81. S'excuser et assurer une intervention rapide. Ne donner ce numéro QUE si incident réel signalé.`;

const EMERGENCY_WITHOUT_BOOKING = `NE PAS donner le numéro d'urgence 06 62 52 43 81. NE PAS donner l'adresse email. En cas de problème urgent, rediriger vers la plateforme de réservation.`;

const SITE_RULE_LOYAL = `Ce voyageur a effectué 3 réservations ou plus. En FIN DE MESSAGE UNIQUEMENT, mentionner naturellement qu'il peut bénéficier d'un tarif préférentiel en réservant directement sur www.locations-residence-industrie.fr`;

const SITE_RULE_DEFAULT = `NE PAS mentionner le site internet www.locations-residence-industrie.fr`;

function getDatetime() {
  return new Date().toLocaleString('fr-FR', {
    timeZone: 'Europe/Paris',
    weekday: 'long', year: 'numeric', month: 'long',
    day: 'numeric', hour: '2-digit', minute: '2-digit'
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

// Récupérer toutes les réservations actives
async function getAllActiveBookings() {
  try {
    const fetch = await getFetch();
    const token = await getBeds24Token();
    if (!token) return [];

    const now = new Date();
    const dateFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const dateTo = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const response = await fetch(
      `https://beds24.com/api/v2/bookings?arrivalFrom=${dateFrom}&departureFrom=${dateFrom}&status=confirmed&maxResults=50`,
      { headers: { 'token': token } }
    );
    const raw = await response.json();
    const bookings = raw?.data || raw;
    if (!Array.isArray(bookings)) return [];

    // Filtrer celles qui sont vraiment actives maintenant
    return bookings.filter(b => {
      const arrival = new Date(b.arrival);
      const departure = new Date(b.departure);
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      return arrival <= tomorrow && departure >= now;
    });
  } catch (err) {
    console.error('Erreur getAllActiveBookings:', err.message);
    return [];
  }
}

// Trouver réservation par roomId
async function getBookingByRoomId(roomId) {
  const bookings = await getAllActiveBookings();
  return bookings.find(b => b.roomId === roomId) || null;
}

// Vérifier voyageur par nom (pour chat web)
async function verifyGuestByName(guestName) {
  if (!guestName || guestName.length < 2) return null;
  try {
    const bookings = await getAllActiveBookings();
    const nameLower = guestName.toLowerCase().trim();
    const nameParts = nameLower.split(/\s+/).filter(p => p.length > 1);

    const match = bookings.find(b => {
      const fn = (b.firstName || '').toLowerCase();
      const ln = (b.lastName || '').toLowerCase();
      return nameParts.some(part => fn.includes(part) || ln.includes(part));
    });

    if (match) {
      console.log(`✅ Voyageur vérifié: ${match.firstName} ${match.lastName} | Logement: ${match.roomId}`);
    } else {
      console.log(`❌ Aucune réservation pour: ${guestName}`);
    }
    return match || null;
  } catch (err) {
    console.error('Erreur verifyGuestByName:', err.message);
    return null;
  }
}

// Compter réservations passées par email
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
    return Array.isArray(bookings) ? bookings.length : 0;
  } catch (err) {
    return 0;
  }
}

function buildSystemPrompt(propInfo, roomInfo, hasActiveBooking, isLoyalGuest) {
  let prompt = BASE_SYSTEM_PROMPT;
  prompt = prompt.replace('{DATETIME}', getDatetime());

  if (hasActiveBooking && propInfo) {
    let rules = RULES_WITH_BOOKING;
    rules = rules.replace('{DIGICODE}', propInfo.digicode);
    rules = rules.replace('{WIFI_PASSWORD}', propInfo.wifi_password);
    prompt = prompt.replace('{SECURITY_RULES}', rules);
    prompt = prompt.replace('{EMERGENCY_RULE}', EMERGENCY_WITH_BOOKING);
  } else {
    prompt = prompt.replace('{SECURITY_RULES}', RULES_WITHOUT_BOOKING);
    prompt = prompt.replace('{EMERGENCY_RULE}', EMERGENCY_WITHOUT_BOOKING);
  }

  prompt = prompt.replace('{SITE_RULE}', isLoyalGuest ? SITE_RULE_LOYAL : SITE_RULE_DEFAULT);

  if (roomInfo && hasActiveBooking) {
    prompt += `\n\n=== INFOS LOGEMENT DU VOYAGEUR ===
- Nom : ${roomInfo.name}
- Code boîte à clé : ${roomInfo.codeBoite}
- Emplacement dans l'immeuble : ${roomInfo.emplacement}
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
          const systemPrompt = buildSystemPrompt(propInfo, null, false, false);
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
    const response = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message } })
    });
    console.log('✅ WhatsApp envoyé à:', to, '| status:', response.status);
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
  } catch (err) {}
}

// ==================== BEDS24 ====================

const processedMessages = new Set();

async function fetchAndReplyBeds24Messages() {
  try {
    const fetch = await getFetch();
    const token = await getBeds24Token();
    if (!token) return;
    const propInfo = await getPropertyInfo();

    // Récupérer les messages récents (dernières 2 heures + non lus)
    const response = await fetch('https://beds24.com/api/v2/bookings/messages?maxResults=100', {
      headers: { 'token': token }
    });
    if (!response.ok) {
      console.log('Erreur messages Beds24:', response.status);
      return;
    }

    const raw = await response.json();
    const messages = raw?.data || raw;
    if (!Array.isArray(messages)) return;

    let newMessages = 0;
    for (const msg of messages) {
      const msgId = msg.id || msg.messageId;
      if (!msgId || processedMessages.has(msgId)) continue;
      processedMessages.add(msgId);

      // Filtre date — après démarrage agent
      const msgTime = msg.time ? new Date(msg.time) : null;
      if (!msgTime || msgTime < AGENT_START_TIME) continue;

      // Filtre type — uniquement messages voyageurs
      const msgType = msg.type || '';
      if (msgType !== 'guest') continue;

      const messageText = msg.message || msg.text || '';
      if (!messageText.trim()) continue;

      newMessages++;
      console.log(`\n📨 Nouveau message Beds24 | ID: ${msgId} | RoomID: ${msg.roomId}`);
      console.log(`   Texte: ${messageText.substring(0, 100)}`);
      console.log(`   Heure: ${msgTime.toISOString()}`);

      // Trouver la réservation et les infos du logement
      const activeBooking = msg.roomId ? await getBookingByRoomId(msg.roomId) : null;
      let roomInfo = null;
      if (propInfo && msg.roomId) roomInfo = propInfo.rooms.find(r => r.id === msg.roomId);

      const guestEmail = activeBooking?.email || null;
      const bookingCount = await countGuestBookings(guestEmail);
      const isLoyal = bookingCount >= 3;

      console.log(`   Réservation: ${activeBooking ? `${activeBooking.firstName} ${activeBooking.lastName}` : 'non trouvée'} | Fidèle: ${isLoyal}`);

      const systemPrompt = buildSystemPrompt(propInfo, roomInfo, !!activeBooking, isLoyal);
      const aiReply = await generateAIReply(messageText, systemPrompt);
      if (aiReply) {
        console.log(`   Réponse: ${aiReply.substring(0, 100)}`);
        await sendBeds24Reply(token, msg, aiReply);
      }
    }

    if (newMessages > 0) console.log(`\n✅ ${newMessages} message(s) Beds24 traité(s)`);

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
        max_tokens: 600,
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
    const response = await fetch('https://beds24.com/api/v2/bookings/messages', {
      method: 'POST',
      headers: { 'token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ bookingId: bookingId, message: replyText, type: 'host' }])
    });
    console.log('✅ Réponse Beds24 envoyée | booking:', bookingId, '| status:', response.status);
  } catch (err) {
    console.error('Erreur envoi Beds24:', err.message);
  }
}

// ==================== ROUTES ====================

app.get('/status', async (req, res) => {
  const token = await getBeds24Token();
  const propInfo = await getPropertyInfo();
  const activeBookings = await getAllActiveBookings();
  res.json({
    beds24: token ? 'connecté' : 'déconnecté',
    anthropic: process.env.ANTHROPIC_KEY ? 'configuré' : 'manquant',
    whatsapp: process.env.WHATSAPP_TOKEN ? 'configuré' : 'manquant',
    logements: propInfo?.rooms?.length || 0,
    reservationsActives: activeBookings.length,
    voyageursActifs: activeBookings.map(b => `${b.firstName} ${b.lastName} (logement ${b.roomId})`),
    messagesTraités: processedMessages.size,
    agentDémarréLe: AGENT_START_TIME.toISOString(),
    heureActuelle: getDatetime()
  });
});

app.get('/test-booking', async (req, res) => {
  try {
    const fetch = await getFetch();
    const token = await getBeds24Token();
    const now = new Date();
    const dateFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const response = await fetch(
      `https://beds24.com/api/v2/bookings?arrivalFrom=${dateFrom}&status=confirmed&maxResults=10`,
      { headers: { 'token': token } }
    );
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

app.get('/setup-beds24', async (req, res) => {
  try {
    const fetch = await getFetch();
    const response = await fetch('https://beds24.com/api/v2/authentication/setup', {
      headers: { 'code': process.env.BEDS24_TOKEN }
    });
    res.json(await response.json());
  } catch (err) { res.json({ error: err.message }); }
});

// Polling Beds24 toutes les 2 minutes
setInterval(fetchAndReplyBeds24Messages, 2 * 60 * 1000);
setTimeout(fetchAndReplyBeds24Messages, 5000);

// Chat web avec vérification d'identité
app.post('/api/chat', async (req, res) => {
  try {
    const fetch = await getFetch();
    const propInfo = await getPropertyInfo();

    const guestName = req.body.guestName || null;
    let activeBooking = null;
    let roomInfo = null;

    if (guestName) {
      activeBooking = await verifyGuestByName(guestName);
      if (activeBooking && propInfo) {
        roomInfo = propInfo.rooms.find(r => r.id === activeBooking.roomId);
      }
    }

    const guestEmail = activeBooking?.email || null;
    const bookingCount = await countGuestBookings(guestEmail);
    const isLoyal = bookingCount >= 3;

    let systemPromptText = buildSystemPrompt(propInfo, roomInfo, !!activeBooking, isLoyal);

    if (!guestName) {
      systemPromptText += `\n\nIDENTIFICATION : Si le voyageur demande des codes d'accès ou informations sensibles, demande-lui son nom complet. NE DONNE AUCUN CODE avant vérification.`;
    } else if (!activeBooking) {
      systemPromptText += `\n\nVÉRIFICATION ÉCHOUÉE pour "${guestName}". Aucune réservation active trouvée. NE PAS donner les codes. Dire : "Je ne trouve pas de réservation à ce nom. Vérifiez l'orthographe ou consultez votre confirmation sur la plateforme de réservation."`;
    }

    const body = { ...req.body, system: systemPromptText };
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
    res.json({ ...data, guestVerified: !!activeBooking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Serveur démarré sur port', PORT));
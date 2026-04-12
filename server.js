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

Tu réponds UNIQUEMENT en français, avec un ton chaleureux, professionnel et rassurant — comme un vrai concierge d'hôtel. Tu ne donnes pas les codes à moins que la reservation soit effective. Tu donnes le contact panne uniquement si le voyageur demande.
Tu es disponible 24h/24 et tu dois toujours apporter une réponse utile et complète.

ADRESSE : 11 rue de l'Industrie, 02100 Saint-Quentin
CONTACT PANNE/INCIDENT (non-urgent) : 06 62 52 43 81
EMAIL : contact@locations-residence-industrie.fr

HORAIRES :
- Arrivée : à partir de 15h00 (check-in autonome)
- Départ : avant 11h00 maximum
- Arrivée anticipée ou départ tardif : possible selon disponibilités, demander la veille ou le jour même

ACCÈS IMMEUBLE :
- Digicode d'entrée : {DIGICODE}
- Wi-Fi mot de passe : {WIFI_PASSWORD}
- Check-in 100% autonome, codes envoyés automatiquement avant l'arrivée
- Codes non reçus → rassurer, vérifier spams

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

PANNES : donner le 06 62 52 43 81, s'excuser, assurer prise en charge rapide
PAIEMENT échoué : finaliser via Airbnb/Booking sinon annulation
DISPONIBILITÉS : orienter vers www.locations-residence-industrie.fr
MACHINE À LAVER : laverie à moins de 10 min à pied
FIDÉLISATION : clients fidèles récompensés, encourager à revenir et laisser un commentaire, après 3 reservations

STYLE : français uniquement, chaleureux et professionnel, phrases courtes, toujours proposer une solution, ne jamais inventer d'informations`;

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

{
  "environment": {
    "time": {
      "now": "2026-04-13T16:20:00+02:00",
      "timezone": "Europe/Paris",
      "date": "2026-04-13"
    }
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
      digicode: prop?.templates?.template1 || 'voir message automatique',
      wifi_password: prop?.templates?.template2 || 'voir message automatique',
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

function buildSystemPrompt(propInfo, roomInfo) {
  let prompt = BASE_SYSTEM_PROMPT;
  if (propInfo) {
    prompt = prompt.replace('{DIGICODE}', propInfo.digicode);
    prompt = prompt.replace('{WIFI_PASSWORD}', propInfo.wifi_password);
  }
  if (roomInfo) {
    prompt += `\n\nINFOS DU LOGEMENT DU VOYAGEUR :
- Nom : ${roomInfo.name}
- Code boîte à clé : ${roomInfo.codeBoite}
- Emplacement : ${roomInfo.emplacement}
- Wifi : ${roomInfo.wifi}`;
  }
  return prompt;
}

// ==================== WHATSAPP WEBHOOK ====================

// Vérification du webhook par Meta
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('Webhook verification:', mode, token);

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook WhatsApp vérifié !');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Token invalide');
    res.sendStatus(403);
  }
});

// Réception des messages WhatsApp
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Répondre immédiatement à Meta

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const messages = change.value?.messages;
        if (!messages) continue;

        for (const message of messages) {
          if (message.type !== 'text') continue;

          const from = message.from; // Numéro du voyageur
          const text = message.text?.body || '';
          const msgId = message.id;

          console.log('📱 WhatsApp message de:', from, '|', text.substring(0, 80));

          const propInfo = await getPropertyInfo();
          const systemPrompt = buildSystemPrompt(propInfo, null);
          const aiReply = await generateAIReply(text, systemPrompt);

          if (aiReply) {
            await sendWhatsAppReply(from, aiReply);
            // Notifier le propriétaire
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
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: message }
      })
    });

    const data = await response.json();
    console.log('✅ Réponse WhatsApp envoyée à:', to, '| status:', response.status);
    return data;
  } catch (err) {
    console.error('Erreur envoi WhatsApp:', err.message);
  }
}

async function notifyOwner(from, question, reply) {
  try {
    // Notifier le numéro principal du propriétaire
    const ownerNumber = process.env.OWNER_PHONE; // ex: 33763781915
    if (!ownerNumber) return;

    const notification = `📱 Nouveau message WhatsApp\n\nDe: +${from}\nQuestion: ${question.substring(0, 100)}\n\nRéponse agent: ${reply.substring(0, 150)}`;
    await sendWhatsAppReply(ownerNumber, notification);
  } catch (err) {
    console.error('Erreur notification propriétaire:', err.message);
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

      console.log('✅ Message Beds24:', msgId, '|', messageText.substring(0, 80));

      let roomInfo = null;
      if (propInfo && msg.roomId) roomInfo = propInfo.rooms.find(r => r.id === msg.roomId);

      const systemPrompt = buildSystemPrompt(propInfo, roomInfo);
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
    console.log('✅ Réponse Beds24 envoyée, booking:', bookingId);
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
    digicode: propInfo?.digicode || 'non trouvé',
    logements: propInfo?.rooms?.length || 0,
    messagesTraités: processedMessages.size,
    agentDémarréLe: AGENT_START_TIME.toISOString()
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

// Polling Beds24 toutes les 2 minutes
setInterval(fetchAndReplyBeds24Messages, 2 * 60 * 1000);
setTimeout(fetchAndReplyBeds24Messages, 10000);

// Chat web
app.post('/api/chat', async (req, res) => {
  try {
    const fetch = await getFetch();
    const propInfo = await getPropertyInfo();
    const body = { ...req.body, system: buildSystemPrompt(propInfo, null) };
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    res.json(await response.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Serveur démarré sur port', PORT));
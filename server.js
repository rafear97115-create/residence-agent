const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const BASE_SYSTEM_PROMPT = `Tu es l'agent concierge de la Résidence de l'Industrie, un ensemble de 5 logements meublés situés au 11 rue de l'Industrie, 02100 Saint-Quentin.

Tu réponds UNIQUEMENT en français, avec un ton chaleureux, professionnel et rassurant — comme un vrai concierge d'hôtel.
Tu es disponible 24h/24 et tu dois toujours apporter une réponse utile et complète.

ADRESSE : 11 rue de l'Industrie, 02100 Saint-Quentin
CONTACT PANNE/INCIDENT (non-urgent) : 06 62 52 43 81
EMAIL : contact@locations-residence-industrie.fr

HORAIRES :
- Arrivée : à partir de 15h00 (check-in autonome)
- Départ : avant 11h00 maximum
- Arrivée anticipée ou départ tardif : possible selon disponibilités, demander la veille ou le jour même

ACCÈS :
- Digicode d'entrée immeuble : {DIGICODE}
- Wi-Fi : réseau {WIFI_NAME} / mot de passe {WIFI_PASSWORD}
- Chaque logement a une boîte à clé avec code
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
FIDÉLISATION : clients fidèles récompensés, encourager à revenir et laisser un commentaire

STYLE : français uniquement, chaleureux et professionnel, phrases courtes, toujours proposer une solution, ne jamais inventer d'informations`;

async function getFetch() {
  const { default: fetch } = await import('node-fetch');
  return fetch;
}

// Token Beds24
let beds24Token = null;
let tokenExpiry = 0;

async function getBeds24Token() {
  const fetch = await getFetch();
  const now = Date.now();
  if (beds24Token && now < tokenExpiry - 300000) return beds24Token;

  const refreshToken = process.env.BEDS24_REFRESH_TOKEN;
  if (!refreshToken) { console.log('BEDS24_REFRESH_TOKEN manquant'); return null; }

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
    console.log('Erreur token Beds24:', JSON.stringify(data));
    return null;
  } catch (err) {
    console.error('Erreur getBeds24Token:', err.message);
    return null;
  }
}

// Cache des infos propriété
let propertyCache = null;
let propertyCacheTime = 0;

async function getPropertyInfo() {
  const now = Date.now();
  if (propertyCache && now - propertyCacheTime < 3600000) return propertyCache;

  try {
    const fetch = await getFetch();
    const token = await getBeds24Token();
    if (!token) return null;

    const response = await fetch('https://beds24.com/api/v2/properties?includeAllRooms=true', {
      headers: { 'token': token }
    });
    const data = await response.json();
    const prop = data?.data?.[0] || data?.[0] || data;

    propertyCache = {
      digicode: prop?.templates?.template1 || 'voir message automatique',
      wifi_name: 'Résidence Industrie',
      wifi_password: prop?.templates?.template2 || 'voir message automatique',
      rooms: (prop?.rooms || []).map(room => ({
        id: room.id,
        name: room.templates?.template2 || room.name,
        codeBoite: room.templates?.template1 || '',
        emplacement: room.templates?.template3 || '',
      }))
    };
    propertyCacheTime = now;
    console.log('Infos propriété chargées:', JSON.stringify(propertyCache).substring(0, 200));
    return propertyCache;
  } catch (err) {
    console.error('Erreur getPropertyInfo:', err.message);
    return null;
  }
}

function buildSystemPrompt(propInfo, roomInfo) {
  let prompt = BASE_SYSTEM_PROMPT;

  if (propInfo) {
    prompt = prompt.replace('{DIGICODE}', propInfo.digicode);
    prompt = prompt.replace('{WIFI_NAME}', propInfo.wifi_name);
    prompt = prompt.replace('{WIFI_PASSWORD}', propInfo.wifi_password);
  }

  if (roomInfo) {
    prompt += `\n\nINFOS LOGEMENT DU VOYAGEUR :
- Nom du logement : ${roomInfo.name}
- Code boîte à clé : ${roomInfo.codeBoite}
- Emplacement : ${roomInfo.emplacement}`;
  }

  return prompt;
}

// Messages déjà traités
const processedMessages = new Set();

async function fetchAndReplyBeds24Messages() {
  try {
    const fetch = await getFetch();
    const token = await getBeds24Token();
    if (!token) return;

    const propInfo = await getPropertyInfo();

    const response = await fetch('https://beds24.com/api/v2/bookings/messages?unread=true', {
      headers: { 'token': token }
    });

    if (!response.ok) {
      console.log('Erreur messages Beds24:', response.status, await response.text());
      return;
    }

    const data = await response.json();
    const messages = data?.data || data;
    if (!Array.isArray(messages)) return;

    console.log('Nouveaux messages non lus:', messages.length);

    for (const msg of messages) {
      const msgId = msg.id || msg.messageId;
      if (!msgId || processedMessages.has(msgId)) continue;
      if (msg.type === 'host' || msg.fromHost || msg.authorOwnerId !== null) continue;

      const messageText = msg.message || msg.text || '';
      if (!messageText.trim()) continue;

      console.log('Message voyageur:', msgId, '-', messageText.substring(0, 100));
      processedMessages.add(msgId);

      // Trouver les infos du logement réservé
      let roomInfo = null;
      if (propInfo && msg.roomId) {
        roomInfo = propInfo.rooms.find(r => r.id === msg.roomId);
      }

      const systemPrompt = buildSystemPrompt(propInfo, roomInfo);
      const aiReply = await generateAIReply(messageText, systemPrompt);
      if (aiReply) await sendBeds24Reply(token, msg, aiReply);
    }
  } catch (err) {
    console.error('Erreur polling:', err.message);
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
    const reply = data.content?.[0]?.text;
    console.log('Réponse IA:', reply?.substring(0, 100));
    return reply || null;
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
    console.log('Réponse envoyée, status:', response.status);
  } catch (err) {
    console.error('Erreur envoi réponse:', err.message);
  }
}

// Routes utilitaires
app.get('/setup-beds24', async (req, res) => {
  try {
    const fetch = await getFetch();
    const code = process.env.BEDS24_TOKEN;
    const response = await fetch('https://beds24.com/api/v2/authentication/setup', {
      headers: { 'code': code }
    });
    res.json(await response.json());
  } catch (err) { res.json({ error: err.message }); }
});

app.get('/status', async (req, res) => {
  const token = await getBeds24Token();
  const propInfo = await getPropertyInfo();
  res.json({
    beds24: token ? 'connecté' : 'déconnecté',
    anthropic: process.env.ANTHROPIC_KEY ? 'configuré' : 'manquant',
    digicode: propInfo?.digicode || 'non trouvé',
    wifi: propInfo?.wifi_password || 'non trouvé',
    logements: propInfo?.rooms?.length || 0,
    messagesTraités: processedMessages.size
  });
});

app.get('/test-templates', async (req, res) => {
  try {
    const fetch = await getFetch();
    const token = await getBeds24Token();
    const response = await fetch('https://beds24.com/api/v2/properties?includeAllRooms=true', {
      headers: { 'token': token }
    });
    res.json(await response.json());
  } catch (err) { res.json({ error: err.message }); }
});

// Polling toutes les 2 minutes
setInterval(fetchAndReplyBeds24Messages, 2 * 60 * 1000);
setTimeout(fetchAndReplyBeds24Messages, 8000);

// Chat web
app.post('/api/chat', async (req, res) => {
  try {
    const fetch = await getFetch();
    const propInfo = await getPropertyInfo();
    const systemPrompt = buildSystemPrompt(propInfo, null);

    const body = { ...req.body, system: systemPrompt };

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
    res.json(data);
  } catch (err) {
    console.error('Erreur chat:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Serveur démarré sur port', PORT));
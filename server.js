const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const SYSTEM_PROMPT = `Tu es l'agent concierge de la Résidence de l'Industrie, un ensemble de 5 logements meublés situés au 11 rue de l'Industrie, 02100 Saint-Quentin.

Tu réponds UNIQUEMENT en français, avec un ton chaleureux, professionnel et rassurant — comme un vrai concierge d'hôtel.
Tu es disponible 24h/24 et tu dois toujours apporter une réponse utile et complète.

ADRESSE : 11 rue de l'Industrie, 02100 Saint-Quentin
CONTACT PANNE/INCIDENT (non-urgent) : 06 62 52 43 81


HORAIRES :
- Arrivée : à partir de 15h00 (check-in autonome)
- Départ : avant 11h00 maximum
- Arrivée anticipée ou départ tardif : possible selon disponibilités, demander la veille ou le jour même

ACCÈS :
- Digicode d'entrée immeuble
- Boîte à clé avec code par logement
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

// Gestion du token Beds24
let beds24Token = null;
let tokenExpiry = 0;

async function getBeds24Token() {
  const fetch = await getFetch();
  const now = Date.now();

  // Si le token est encore valide (marge de 5 min)
  if (beds24Token && now < tokenExpiry - 300000) {
    return beds24Token;
  }

  // Renouveler avec le refresh token
  const refreshToken = process.env.BEDS24_REFRESH_TOKEN;
  if (!refreshToken) {
    console.log('BEDS24_REFRESH_TOKEN non configuré');
    return null;
  }

  try {
    const response = await fetch('https://beds24.com/api/v2/authentication/token', {
      headers: { 'refreshToken': refreshToken }
    });
    const data = await response.json();

    if (data.token) {
      beds24Token = data.token;
      tokenExpiry = now + (data.expiresIn * 1000);
      console.log('Token Beds24 renouvelé, expire dans', data.expiresIn, 'secondes');
      return beds24Token;
    } else {
      console.log('Erreur renouvellement token:', JSON.stringify(data));
      return null;
    }
  } catch (err) {
    console.error('Erreur getBeds24Token:', err.message);
    return null;
  }
}

// Stockage des messages déjà traités
const processedMessages = new Set();

async function fetchAndReplyBeds24Messages() {
  try {
    const fetch = await getFetch();
    const token = await getBeds24Token();
    if (!token) return;

    // Récupérer les réservations récentes avec messages
    const response = await fetch('https://beds24.com/api/v2/bookings/messages?unread=true', {
      headers: { 'token': token, 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      const text = await response.text();
      console.log('Erreur Beds24 messages:', response.status, text);
      return;
    }

    const data = await response.json();
    console.log('Messages Beds24:', JSON.stringify(data).substring(0, 300));

    if (!data || !Array.isArray(data)) return;

    for (const msg of data) {
      const msgId = msg.id || msg.messageId;
      if (!msgId || processedMessages.has(msgId)) continue;
      if (msg.type === 'host' || msg.fromHost) continue; // Ignorer nos propres messages

      console.log('Nouveau message voyageur ID:', msgId, '- Texte:', msg.message || msg.text);
      processedMessages.add(msgId);

      const messageText = msg.message || msg.text || '';
      if (!messageText.trim()) continue;

      const aiReply = await generateAIReply(messageText);
      if (aiReply) {
        await sendBeds24Reply(token, msg, aiReply);
      }
    }
  } catch (err) {
    console.error('Erreur polling messages:', err.message);
  }
}

async function generateAIReply(userMessage) {
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
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
      })
    });
    const data = await response.json();
    const reply = data.content?.[0]?.text;
    console.log('Réponse IA générée:', reply?.substring(0, 100));
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
      body: JSON.stringify([{
        bookingId: bookingId,
        message: replyText,
        type: 'host'
      }])
    });

    const result = await response.json();
    console.log('Réponse envoyée à Beds24:', JSON.stringify(result).substring(0, 200));
  } catch (err) {
    console.error('Erreur envoi réponse Beds24:', err.message);
  }
}

// Route pour setup initial Beds24
app.get('/setup-beds24', async (req, res) => {
  try {
    const fetch = await getFetch();
    const code = process.env.BEDS24_TOKEN;
    const response = await fetch('https://beds24.com/api/v2/authentication/setup', {
      headers: { 'code': code }
    });
    const data = await response.json();
    console.log('Beds24 setup:', JSON.stringify(data));
    res.json(data);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Route statut
app.get('/status', async (req, res) => {
  const token = await getBeds24Token();
  res.json({
    beds24: token ? 'connecté' : 'déconnecté',
    anthropic: process.env.ANTHROPIC_KEY ? 'configuré' : 'manquant',
    messagesTraités: processedMessages.size
  });
});

app.get('/test-templates', async (req, res) => {
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

// Vérifier les messages toutes les 2 minutes
setInterval(fetchAndReplyBeds24Messages, 2 * 60 * 1000);
setTimeout(fetchAndReplyBeds24Messages, 8000);

// Route chat web
app.post('/api/chat', async (req, res) => {
  try {
    const fetch = await getFetch();
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
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
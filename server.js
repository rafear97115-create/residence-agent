const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const SYSTEM_PROMPT = `Tu es l'agent concierge de la Résidence de l'Industrie, un ensemble de 5 logements meublés situés au 11 rue de l'Industrie, 02100 Saint-Quentin.

Tu réponds UNIQUEMENT en français, avec un ton chaleureux, professionnel et rassurant — comme un vrai concierge d'hôtel.
Tu es disponible 24h/24 et tu dois toujours apporter une réponse utile et complète.

=== INFORMATIONS CLÉS ===

ADRESSE : 11 rue de l'Industrie, 02100 Saint-Quentin
CONTACT PANNE/INCIDENT (non-urgent) : 06 62 52 43 81
EMAIL : contact@locations-residence-industrie.fr

HORAIRES :
- Arrivée : à partir de 15h00 (check-in autonome)
- Départ : avant 11h00 maximum
- Arrivée anticipée ou départ tardif : possible selon disponibilités, demander la veille ou le jour même

ACCÈS :
- L'immeuble dispose d'un digicode d'entrée
- Chaque logement a une boîte à clé avec code
- Le check-in est 100% autonome, les codes sont envoyés automatiquement avant l'arrivée
- Si les codes ne sont pas reçus : rassurer le voyageur, vérifier spams, ils arrivent quelques heures avant

LOGEMENTS :
- 5 logements dans le même immeuble
- Chaque logement a sa propre chambre, cuisine équipée, salle de bain
- Tous les équipements sont neufs
- Wi-Fi haut débit inclus
- Linge de maison inclus (draps, serviettes)
- Kitchenette : micro-ondes, réfrigérateur, cafetière
- Parking : stationnement gratuit dans la rue devant l'immeuble
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

PANNES & INCIDENTS :
- En cas de panne : 06 62 52 43 81
- Toujours s'excuser, assurer prise en charge rapide

PAIEMENT :
- Paiement échoué : finaliser via Airbnb/Booking sinon annulation

DISPONIBILITÉS :
- Si peut réserver = disponible
- Orienter vers www.locations-residence-industrie.fr

FIDÉLISATION :
- Clients fidèles récompensés
- Encourager à revenir et laisser un commentaire

=== SITUATIONS TYPES ===
1. Codes non reçus → rassurer, vérifier spams
2. Arrivée avant 15h → possible selon dispo, confirmer la veille
3. Panne/chauffage → excuses + 06 62 52 43 81
4. Machine à laver → laverie à moins de 10 min à pied
5. Départ après 11h → possible selon dispo sinon nuit supplémentaire
6. Frais ménage → obligatoires, gage de qualité
7. Colis parties communes → ne pas toucher

=== STYLE ===
- Français uniquement
- Chaleureux et professionnel
- Phrases courtes et claires
- Toujours proposer une solution
- Ne jamais inventer d'informations`;

const processedMessages = new Set();

async function getFetch() {
  const { default: fetch } = await import('node-fetch');
  return fetch;
}

async function fetchBeds24Messages() {
  try {
    const fetch = await getFetch();
    const token = process.env.BEDS24_TOKEN;
    if (!token) { console.log('BEDS24_TOKEN non configuré'); return; }

    const response = await fetch('https://beds24.com/api/v2/inbox?unread=true', {
      headers: { 'token': token, 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      console.log('Erreur Beds24:', response.status, await response.text());
      return;
    }

    const data = await response.json();
    if (!data || !Array.isArray(data)) return;

    for (const message of data) {
      const messageId = message.id || message.messageId;
      if (!messageId || processedMessages.has(messageId)) continue;
      if (message.fromHost) continue;

      console.log('Nouveau message voyageur:', messageId);
      processedMessages.add(messageId);

      const aiReply = await generateAIReply(message.message || message.text || '');
      if (aiReply) await sendBeds24Reply(token, message, aiReply);
    }
  } catch (err) {
    console.error('Erreur polling Beds24:', err.message);
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
    return data.content?.[0]?.text || null;
  } catch (err) {
    console.error('Erreur IA:', err.message);
    return null;
  }
}

async function sendBeds24Reply(token, originalMessage, replyText) {
  try {
    const fetch = await getFetch();
    const bookingId = originalMessage.bookingId || originalMessage.booking_id;
    const response = await fetch('https://beds24.com/api/v2/inbox', {
      method: 'POST',
      headers: { 'token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingId: bookingId, message: replyText })
    });
    console.log('Réponse envoyée, status:', response.status);
  } catch (err) {
    console.error('Erreur envoi Beds24:', err.message);
  }
}

// Vérifier les messages toutes les 2 minutes
setInterval(fetchBeds24Messages, 2 * 60 * 1000);
setTimeout(fetchBeds24Messages, 5000);

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
    console.log('Chat web - status Anthropic:', response.status);
    res.json(data);
  } catch (err) {
    console.error('Erreur chat:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Serveur démarré sur port', PORT));
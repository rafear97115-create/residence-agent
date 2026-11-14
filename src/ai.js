/*
 * ai.js — Claude : appels API, outil de disponibilités, réponses de politesse
 * (extrait de l'ancien server.js ; voir server.js pour l'architecture)
 */

const { ALERT_RE } = require('./alerts');
const { checkAvailability } = require('./beds24');
const { CLAUDE_MODEL, COURTESY_MODEL } = require('./config');
const { toSystemBlocks } = require('./prompts');
const { fetchT, normalizeText, parisToday } = require('./utils');

const TOOLS = [{
  name: 'check_availability',
  description: "Vérifie en temps réel quels logements de la Résidence sont libres ou occupés pour un séjour (nuit d'arrivée incluse, jour de départ exclu). À appeler dès que le voyageur a donné ou confirmé des dates d'arrivée et de départ pour une NOUVELLE réservation, ou pour vérifier une PROLONGATION (du jour de départ actuel à la nouvelle date de départ).",
  input_schema: {
    type: 'object',
    properties: {
      arrival: { type: 'string', description: "Date d'arrivée au format AAAA-MM-JJ" },
      departure: { type: 'string', description: 'Date de départ au format AAAA-MM-JJ (strictement après arrivée)' }
    },
    required: ['arrival', 'departure']
  }
}];

async function executeTool(name, input) {
  if (name !== 'check_availability') return { error: true, text: `Outil inconnu : ${name}` };
  try {
    const { arrival, departure } = input || {};
    const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v + 'T00:00:00Z'));
    if (!isDate(arrival) || !isDate(departure)) return { error: true, text: 'Dates invalides : utilise le format AAAA-MM-JJ.' };
    const today = parisToday();
    if (arrival < today) return { error: true, text: `La date d'arrivée ${arrival} est passée (aujourd'hui : ${today}).` };
    if (departure <= arrival) return { error: true, text: "La date de départ doit être après la date d'arrivée." };
    const nights = Math.round((new Date(departure) - new Date(arrival)) / 86400000);
    if (nights > 90) return { error: false, text: `Ce séjour fait ${nights} nuits : la durée maximale est de 90 jours. Propose au voyageur de réduire la durée.` };

    const result = await checkAvailability(arrival, departure);
    if (!result) return { error: true, text: 'Vérification momentanément indisponible. Ne garantis rien ; donne les liens de réservation.' };

    let text = `VÉRIFICATION EN TEMPS RÉEL — séjour du ${arrival} au ${departure} (${nights} nuit(s)) :\n`;
    text += result.free.length ? `Logements LIBRES :\n- ${result.free.join('\n- ')}\n` : 'Aucun logement libre sur ces dates.\n';
    if (result.occupied.length) text += `Logements OCCUPÉS : ${result.occupied.join(', ')}\n`;
    text += "Présente ces informations au voyageur (cite les logements libres par leur nom et leur numéro), avec le lien de réservation selon PRÉSENTATION DES MOYENS DE RÉSERVATION. S'il n'y a aucun logement libre, dis que ces dates sont complètes et propose d'autres dates.";
    return { error: false, text };
  } catch (err) {
    console.error('Erreur executeTool:', err.message);
    return { error: true, text: 'Vérification momentanément indisponible. Ne garantis rien ; donne les liens de réservation.' };
  }
}

// ==================== POLITESSES : réponse brève, sans répétition ====================

const EMOJI = '[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{FE0F}]';
const COURTESY_RE = new RegExp(`^(?:\\s|[!.,;:…]|${EMOJI}|merci(?: beaucoup| bien)?|thanks?(?: you)?|au plaisir|a bientot|a tout a l'heure|bonne (?:soiree|nuit|journee)|bien recu|genial)+$`, 'iu');
const AMBIGUOUS_RE = new RegExp(`^(?:\\s|[!.,;:…]|${EMOJI}|ok|okay|d'accord|dac|entendu|nickel|recu|c'est bon|merci(?: beaucoup)?|super|parfait|top|cool)+$`, 'iu');

// lastAssistant : dernier message du bot (null = inconnu → on ne traite pas comme politesse les "ok" ambigus)
function isPureCourtesy(text, lastAssistant) {
  const t = normalizeText(String(text || '').replace(/[’‘]/g, "'")).trim();
  if (!t || t.length > 40) return false;
  if (COURTESY_RE.test(t)) return true;
  if (lastAssistant === null || lastAssistant === undefined) return false;
  const askedQuestion = /\?\s*(?:[^\w\s]|\s)*$/.test(String(lastAssistant).trim());
  return !askedQuestion && AMBIGUOUS_RE.test(t);
}

const COURTESY_SYSTEM = `Tu es l'assistant virtuel de la Résidence de l'Industrie (un assistant automatisé, pas une personne). Le voyageur vient d'envoyer un simple remerciement, un au revoir ou un accusé de réception.
Réponds par UNE seule courte phrase chaleureuse (une dizaine de mots), dans la langue du voyageur.
Varie la formulation : ne reprends ni les mots ni la tournure de tes réponses précédentes dans la conversation.
Sans question, sans lien, sans relance commerciale, sans markdown, sans balise. Un emoji au maximum, et seulement si le voyageur en a utilisé un.`;

async function generateCourtesyReply(text, history = []) {
  const reply = await runConversation({
    system: COURTESY_SYSTEM,
    messages: [...history, { role: 'user', content: String(text).substring(0, 200) }],
    maxTokens: 80,
    tools: [],
    model: COURTESY_MODEL
  });
  return reply ? reply.replace(ALERT_RE, '').trim() || null : null;
}

// ==================== CLAUDE ====================

// 2 nouvelles tentatives après un échec temporaire (réseau, délai dépassé, 429 trop de requêtes, 5xx, 529 surcharge), avec attente.
// Tableau modifiable : les tests le raccourcissent.
const AI_RETRY_DELAYS_MS = [1500, 4000];
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Un appel à l'API Anthropic, avec nouvelles tentatives. Retourne { response, data } ou null (échec définitif).
async function callAnthropic(body, timeoutMs) {
  for (let attempt = 0; ; attempt++) {
    let response = null, data = null, netErr = null;
    try {
      response = await fetchT('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
      }, timeoutMs);
      data = await response.json().catch(() => null);
    } catch (err) {
      netErr = err;
    }
    if (response && response.ok && data) return { response, data };

    const status = response ? response.status : 0;
    // Réessayer : erreur réseau/délai, statut temporaire, ou 200 sans JSON lisible. Ne pas réessayer : 400, 401, 403, 404... (le résultat serait le même)
    const retryable = !!netErr || (response.ok ? true : RETRYABLE_STATUS.has(status));
    const why = netErr ? `réseau/délai (${netErr.name || 'erreur'})` : `HTTP ${status}`;
    if (!retryable || attempt >= AI_RETRY_DELAYS_MS.length) {
      console.error(`Erreur Anthropic (${why}), abandon après ${attempt + 1} essai(s) :`, data ? JSON.stringify(data).substring(0, 500) : '(pas de corps lisible)');
      return null;
    }
    let wait = AI_RETRY_DELAYS_MS[attempt];
    const ra = response && response.headers && Number(response.headers.get('retry-after'));
    if (ra > 0 && ra <= 10) wait = Math.max(wait, ra * 1000);
    console.warn(`⚠️ Anthropic : ${why}, nouvel essai ${attempt + 2}/${AI_RETRY_DELAYS_MS.length + 1} dans ${Math.round(wait / 100) / 10} s`);
    await sleep(wait);
  }
}

// Réponse coupée par la limite de longueur : on retire une balise [[ALERTE:...]] restée ouverte, puis on coupe à la dernière phrase complète
function trimTruncated(text) {
  let t = String(text || '').replace(/\[\[[^\]]*$/, '').trimEnd();
  const m = t.match(/^[\s\S]*[.!?…](?=\s|$)/);
  if (m && m[0].length >= t.length * 0.5) t = m[0];
  return t.trim();
}

async function runConversation({ system, messages, maxTokens = 1000, tools = TOOLS, model = CLAUDE_MODEL, timeoutMs = 40000 }) {
  const msgs = messages.slice();
  let limit = maxTokens;
  let truncRetried = false;
  try {
    for (let i = 0; i < 4; i++) {
      const body = { model, max_tokens: limit, system: toSystemBlocks(system), messages: msgs };
      if (tools && tools.length) body.tools = tools;
      const out = await callAnthropic(body, timeoutMs);
      if (!out) return null;
      const data = out.data;
      if (data.usage) console.log(`🧠 Tokens : entrée ${data.usage.input_tokens || 0} | cache lu ${data.usage.cache_read_input_tokens || 0} | cache écrit ${data.usage.cache_creation_input_tokens || 0} | sortie ${data.usage.output_tokens || 0}`);

      // Réponse coupée (max_tokens) : une seconde tentative avec une limite doublée (3000 au plus), sans consommer un tour d'outil
      if (data.stop_reason === 'max_tokens' && !truncRetried) {
        truncRetried = true;
        limit = Math.min(maxTokens * 2, 3000);
        console.warn(`✂️ Réponse coupée à ${maxTokens} jetons : nouvel essai avec ${limit}`);
        i--;
        continue;
      }
      if (data.stop_reason === 'tool_use') {
        msgs.push({ role: 'assistant', content: data.content });
        const results = [];
        for (const block of (data.content || []).filter(b => b.type === 'tool_use')) {
          const toolOut = await executeTool(block.name, block.input);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: toolOut.text, ...(toolOut.error ? { is_error: true } : {}) });
        }
        msgs.push({ role: 'user', content: results });
        continue;
      }
      const text = (data.content || []).filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n').trim();
      if (!text) {
        console.error('Réponse Claude sans texte:', JSON.stringify(data).substring(0, 500));
        return null;
      }
      if (data.stop_reason === 'max_tokens') {
        // Toujours coupée : jamais de phrase tronquée envoyée au voyageur
        console.warn('✂️ Réponse encore coupée après le second essai : coupée à la dernière phrase complète');
        return trimTruncated(text) || null;
      }
      return text;
    }
    console.error('Trop de tours d\'outils sans réponse finale');
    return null;
  } catch (err) {
    console.error('Erreur IA:', err.message);
    return null;
  }
}

async function generateAIReply(userMessage, systemPrompt, history = []) {
  return runConversation({
    system: systemPrompt,
    messages: [...history, { role: 'user', content: userMessage }]
  });
}

module.exports = {
  TOOLS,
  executeTool,
  EMOJI,
  COURTESY_RE,
  AMBIGUOUS_RE,
  isPureCourtesy,
  COURTESY_SYSTEM,
  generateCourtesyReply,
  AI_RETRY_DELAYS_MS,
  callAnthropic,
  trimTruncated,
  runConversation,
  generateAIReply
};

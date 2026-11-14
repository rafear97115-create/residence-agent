/*
 * rooms.js — Logements : numéros, liens Airbnb, équipements Beds24
 * (extrait de l'ancien server.js ; voir server.js pour l'architecture)
 */

const { normalizeText } = require('./utils');

const FEATURE_CODES_IGNORE = new Set((process.env.FEATURE_CODES_IGNORE || 'PACK_N_PLAY_TRAVEL_CRIB,WIFI_POCKET,CLEANING_BEFORE_CHECKOUT')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean));

function flattenFeatures(fc) {
  const out = [];
  for (const g of (Array.isArray(fc) ? fc : [])) {
    for (const c of (Array.isArray(g) ? g : [g])) {
      const code = String(c || '').trim().toUpperCase();
      if (/^[A-Z0-9_]{2,40}$/.test(code) && !FEATURE_CODES_IGNORE.has(code) && !out.includes(code)) out.push(code);
    }
  }
  return out;
}

// Fiche par logement construite depuis Beds24 : surface, capacité, équipements (communs à tous, puis différences)
function beds24UnitSheet(propInfo) {
  const rooms = (propInfo?.rooms || []).filter(r => r.size || r.maxPeople || (r.features && r.features.length));
  if (!rooms.length) return '';
  const numbers = buildRoomNumbers(propInfo);
  const common = rooms[0].features.filter(c => rooms.every(r => r.features.includes(c)));
  const lines = rooms.map(r => {
    const num = numbers.get(String(r.id));
    const link = AIRBNB_LINKS.find(l => l.num === num);
    const label = link ? `Logement ${link.num} (${link.nom})` : (r.name || `Logement ${r.id}`);
    const extra = r.features.filter(c => !common.includes(c));
    const parts = [];
    if (r.size) parts.push(`${r.size} m²`);
    if (r.maxPeople) parts.push(`${r.maxPeople} personnes maximum`);
    if (extra.length) parts.push(`équipements en plus : ${extra.join(', ')}`);
    return `- ${label} : ${parts.join(' ; ') || 'aucune donnée'}`;
  });
  return `Source : Beds24 (codes d'équipements, à traduire en français pour le voyageur).
Équipements communs à tous les logements : ${common.join(', ') || 'aucun'}
${lines.join('\n')}
Un équipement qui n'apparaît pas ici est INCONNU (pas forcément absent) : ne dis pas qu'il n'existe pas, dis que tu transmets la question au Service Relation Client (balise contact_humain).`;
}

// Numéro de logement (1 à 5) de chaque logement Beds24 : d'abord ROOM_MAP (réglage manuel), puis le nom (Agate, Bégonia...)
let ROOM_MAP = {};
try { ROOM_MAP = JSON.parse(process.env.ROOM_MAP || '{}'); } catch (e) { console.warn('⚠️ ROOM_MAP invalide (JSON attendu) : ignoré'); }

function buildRoomNumbers(propInfo) {
  const map = new Map();
  for (const r of (propInfo?.rooms || [])) {
    const n = normalizeText(r.name);
    const l = AIRBNB_LINKS.find(x => x.mots.some(m => n.includes(m)));
    const byNumber = n.match(/logement\s*(?:n°|no|numero)?\s*([1-5])(?!\d)/); // ex. "le logement 3"
    if (l) map.set(String(r.id), l.num);
    else if (byNumber) map.set(String(r.id), Number(byNumber[1]));
  }
  for (const [id, num] of Object.entries(ROOM_MAP)) if (Number(num)) map.set(String(id), Number(num));
  return map;
}

// Les 5 logements (numéro, nom, mots reconnus dans Beds24 ou dans les messages). Airbnb n'ayant plus qu'un lien pour l'immeuble, il n'y a plus de lien par logement (voir AIRBNB_URL).
const AIRBNB_LINKS = [
  { num: 1, nom: 'Agate', mots: ['agate'] },
  { num: 2, nom: 'Bégonia', mots: ['begonia'] },
  { num: 3, nom: 'Capucine', mots: ['capucine'] },
  { num: 4, nom: 'Dahlia', mots: ['dahlia'] },
  { num: 5, nom: 'Églantine', mots: ['eglantine'] }
];

// "3 Capucine" (numéro + nom), sinon le nom Beds24
function describeRoom(roomId, propInfo) {
  const num = buildRoomNumbers(propInfo).get(String(roomId));
  const link = AIRBNB_LINKS.find(l => l.num === num);
  if (num && link) return `${num} ${link.nom}`;
  const name = propInfo?.rooms?.find(r => String(r.id) === String(roomId))?.name;
  return name || String(roomId);
}

module.exports = {
  FEATURE_CODES_IGNORE,
  flattenFeatures,
  beds24UnitSheet,
  buildRoomNumbers,
  AIRBNB_LINKS,
  describeRoom
};

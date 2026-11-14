# Modifications

## Version 1.2 (13/11/2026, soir)
### Sécurité
1. **Liste de noms** : un message contenant les noms de famille de plusieurs voyageurs différents ne valide plus personne (le critère « nom » est ignoré,
   la tentative compte comme un échec). Avant, nom + dates + logement devinés depuis un numéro inconnu pouvaient donner les codes.
   Deux réservations au même nom de famille ne sont pas considérées comme une liste (`detectNameSpray`, `identity.js`).
2. **Numéro d'urgence** : plus jamais écrit dans les consignes données aux voyageurs non vérifiés (il y figurait dans la phrase « NE PAS donner le numéro… »).
   Nouveau filet en sortie (`applyPhonePolicy`, `security.js`) : retiré de toute réponse destinée à un voyageur non vérifié, quelle que soit sa présentation
   (espaces, points, +33, 0033…). Appliqué sur WhatsApp, Airbnb/Booking et chat du site.
3. **Données personnelles sorties du code** : numéro d'urgence → variable `EMERGENCY_PHONE` ; adresse exacte → variable `ADDRESS_FULL`. Vides : le bot ne donne
   ni l'un ni l'autre (avertissement au démarrage). Le filtre d'adresse se construit aussi à partir de `ADDRESS_FULL`. Un test vérifie qu'aucun numéro de
   téléphone ni l'adresse n'est écrit dans le code.
4. **Prospects bloqués à tort** : demander une disponibilité avec des dates ou un logement n'est plus compté comme une tentative de devinette (avant : blocage
   de 90 jours après 5 messages, et plafond global de 30 échecs/heure consommé). Distinction : échec « fort » (nom/email qui correspond presque, texte suspect :
   5 maximum) et échec « faible » (aucune réservation ne correspond : blocage seulement au-delà de `MAX_SOFT_ATTEMPTS` = 25 en 24 h, sans effet sur le plafond global).
   Un voyageur dont le numéro WhatsApp correspond à la réservation n'est jamais compté.

### Chat du site
- **Ne vérifie plus personne** : nom, téléphone et email envoyés par le navigateur sont ignorés (ils ne débloquaient aucun code mais faisaient révéler dates et logement
  d'un séjour). La réponse ne contient plus `guestVerified`. Le formulaire « J'ai une réservation en cours » est retiré du widget ; il envoie un identifiant de session aléatoire.
- Le widget affiche une information « assistant automatisé (IA), messages transmis à un prestataire d'IA » et, avec `data-privacy="https://…"`, un lien « Données personnelles ».

### RGPD
- Nouveau fichier `RGPD.md` : textes prêts à reprendre dans la politique de confidentialité et registre des traitements.
- Variable `PRIVACY_URL` (optionnelle) : le premier message du bot (WhatsApp, Airbnb, Booking) précise qu'il s'agit d'un assistant automatisé et donne le lien.
- Conservation d'un numéro WhatsApp vérifié : 30 jours après son dernier message (avant : 100 jours). Numéro bloqué : inchangé (`LOCK_DAYS` + 10 jours).

### Airbnb, Beds24, commandes
- **Un seul lien Airbnb** (`AIRBNB_URL`, défaut : le lien du logement 1, qui mène à l'annonce de l'immeuble). Plus de lien par logement : le bot cite les logements libres par leur nom.
- **Panne Beds24** : le bot ne répond plus à la place du propriétaire. Message Airbnb/Booking reçu pendant une panne = une alerte avec le texte du message (« répondez dans Airbnb / Booking »),
  marqué traité (pas de réponse tardive par-dessus la vôtre). Panne détectée à la relève (2 échecs de suite, environ 4 min) ou à la vérification d'un voyageur WhatsApp : alerte (1 par heure au plus),
  puis message de retour à la normale.
- **`/sejour`** : trois listes : départs ce jour, en cours (arrivées du jour comprises), à venir (30 prochains jours par défaut).
- Node 22 (`engines`, `.nvmrc`).

## Version du 13/11/2026
### Corrections prioritaires
1. **`public/index.html` supprimé** : la page publique affichait le numéro d'urgence et l'adresse exacte, et ses « réponses instantanées » (panne, bloqué dehors)
   n'appelaient pas le serveur : aucune alerte propriétaire. Les infos utiles ont été reprises dans le prompt (restaurants et visites de Saint-Quentin,
   section `SAINT-QUENTIN : RESTAURANTS ET VISITES`). `GET /` répond maintenant par un simple message texte.
2. **Panne Beds24 : la vérification des voyageurs n'est plus effacée** (y compris un `/valider` manuel). Elle n'est effacée que si Beds24 a *répondu* que la
   réservation n'est plus valable. En cas de panne : dernière liste connue (30 min au plus), sinon vérification conservée mais aucun code pour ce message.
3. **`redactSecrets` (chat web)** : une seule passe, secrets du plus long au plus court (un code court contenu dans un mot de passe laissait fuiter un morceau).

### Points importants
- **`/valider`** : refuse (avec la raison et la date) si la réservation n'est pas *confirmée*, si le séjour est terminé ou s'il commence dans plus d'un jour ;
  avertit si le numéro diffère du téléphone de la réservation ; contrôle que la validation a tenu ; signale une panne Beds24.
- **Plafond global d'échecs de vérification** (`VERIFY_FAIL_GLOBAL_LIMIT`, 30 par heure, WhatsApp + chat web) : au-delà, la vérification automatique est
  suspendue pour les *nouveaux* voyageurs, le propriétaire est alerté (une fois par heure), `/valider` reste possible. Visible dans `/statut`.
- **Alertes d'annulation** (❌, `CANCEL_WATCH=off` pour couper) : pas pour un séjour terminé ni pour une demande jamais confirmée puis expirée/refusée.
- **Alertes de modification** (🔄, `MODIFY_WATCH=off` pour couper) : changement de dates ou de logement d'une réservation confirmée, avec « Avant / Après ».
  Le bot mémorise les dates et le logement de chaque réservation confirmée (fichier d'état) et en reprend la liste 45 s après chaque démarrage.
  Vos propres modifications dans Beds24 sont signalées aussi.
- **Appels à Claude** : 2 nouvelles tentatives (attentes 1,5 s puis 4 s) après une erreur réseau, un délai dépassé, 429, 5xx ou 529 ; aucune nouvelle tentative
  pour 400/401/403/404. Délai par essai : 40 s (25 s pour le chat web).
- **Réponses tronquées** (`max_tokens`) : second essai avec une limite doublée ; si c'est encore coupé, la réponse est coupée à la dernière phrase complète
  (balise `[[ALERTE:...]]` restée ouverte retirée). Aucune phrase coupée n'est envoyée au voyageur.
- Modèle : `CLAUDE_MODEL` (défaut `claude-sonnet-5-5`) et `COURTESY_MODEL` (défaut = `CLAUDE_MODEL`, ex. `claude-haiku-5-5`).

### Points mineurs
- Filtre d'adresse : « 11 rue Industrie » (sans « de ») et « rue de l'Industrie 11 » (numéro après la rue) sont maintenant masqués.
- Filet `fallbackCategory` (utilisé seulement si le modèle oublie la balise) : plus de fausses alertes pour « quelle direction pour la gare ? »,
  « le responsable du parking ? », « bloquer une date », « le voisinage ». Il faut une vraie formulation (« parler au responsable », « je suis bloqué dehors »).
- Codes d'accès : donnés **uniquement** à un voyageur identifié, du **jour précédant l'arrivée** jusqu'au jour du départ inclus. Textes du prompt alignés.
- Avertissements au démarrage si `ANTHROPIC_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `OWNER_PHONE` ou `BEDS24_REFRESH_TOKEN` sont vides.
- Gestionnaire d'erreurs Express (JSON invalide, message trop gros, bug : réponse JSON courte, jamais de trace d'erreur) ; réponse JSON pour une route inconnue ;
  `unhandledRejection` journalisée ; `uncaughtException` : sauvegarde de l'état puis arrêt (Render redémarre).
- `package.json` : script `start`, `engines` (Node 18+), `private`, dépendance `node-fetch` retirée (fetch natif). Lancer `npm install` une fois et **ajouter
  `package-lock.json` au dépôt**.
- `.gitignore` ajouté (`node_modules/`, `state.json`, `.env`). Tests : `npm test` (dossier `test/`, aucun réseau).

## Comportement après un redémarrage
Redémarrages fréquents : chaque déploiement, mise en veille de l'offre gratuite Render, plantage.

| | Disque persistant (`/var/data` ou `STATE_FILE`) | Sans disque persistant |
|---|---|---|
| Pauses, voyageurs vérifiés, numéros bloqués et compteurs d'échecs | **conservés** | perdus : les voyageurs doivent se revérifier, les blocages sautent |
| Alertes déjà envoyées, bot déjà présenté, dates/logement des réservations | **conservés** | perdus (voir ci-dessous) |
| Historique des conversations WhatsApp (10 messages) et texte déjà donné pour se faire identifier | perdus dans tous les cas : un voyageur pas encore reconnu doit redonner son nom, ses dates et son logement | idem |
| Compteurs de limites (chat, échecs de vérification, par IP) et anti-spam des alertes | perdus dans tous les cas (remis à zéro) | idem |
| Jeton Beds24 obtenu via `/setup-beds24` | perdu s'il n'a pas été copié dans `BEDS24_REFRESH_TOKEN` | idem |

- **Messages Airbnb/Booking arrivés pendant l'arrêt** : réponse tardive si le message a moins de `CATCHUP_HOURS` (12 h) et si personne n'a répondu depuis.
  Un simple « merci » reçu pendant l'arrêt n'obtient pas de réponse tardive. Un message pour lequel l'envoi avait échoué 3 fois peut être retenté.
- **Messages WhatsApp arrivés pendant l'arrêt** : Meta réessaie un certain temps ; les doublons sont écartés (6 h).
- **Sans état rechargé**, au premier passage de surveillance : les réservations modifiées plus de 30 min avant le démarrage sont considérées comme déjà
  signalées (pas de doublons). Une vraie nouvelle réservation arrivée pendant un arrêt de plus de 30 min peut donc ne pas être signalée : consultez `/sejour`.
- **Dates/logement des réservations** : rechargés depuis Beds24 45 s après le démarrage. Une modification faite *pendant* l'arrêt, sans état sauvegardé,
  n'est pas signalée.

## Réduction du nombre de variables Render
- **Variable `SECRETS`** (nouveau fichier `src/secrets.js`, chargé en premier par `server.js`) : un seul JSON peut remplacer toutes les autres variables
  (ex. `{"ANTHROPIC_KEY":"...","WHATSAPP_TOKEN":"..."}`). Une variable Render séparée du même nom reste prioritaire.
- **Identifiants non secrets** (`OWNER_PHONE`, `WHATSAPP_PHONE_ID`, `TELEGRAM_CHAT_ID`, `WHATSAPP_ALERT_TEMPLATE(_LANG)`) : variable Render du même nom, ou valeur écrite en dur dans `config.js` à la place de `''`. Vides, le bot démarre mais ne peut pas alerter : voir les avertissements au démarrage.

## Version du 12/11/2026
1. **Alerte de nouvelle réservation Airbnb / Booking** : seules les demandes en attente et les réservations directes (site) étaient signalées ;
   une réservation Airbnb/Booking confirmée d'emblée (réservation instantanée, ou demande acceptée) ne déclenchait aucune alerte.
   Nouveau type d'alerte « ✅ Nouvelle réservation confirmée (Airbnb / Booking) » (`bookingEventKind` → `'confirmed'`), avec la commande `/repondre bID`.
   Une demande déjà signalée puis acceptée est signalée à nouveau comme confirmée, même si la demande a plus de 12 h.
2. **Réponse du bot incohérente** : pour une réservation confirmée dont le séjour n'a pas commencé, le bot traitait le voyageur comme un prospect
   (« indiquez-moi vos dates, je vérifie les disponibilités »). Il connaît maintenant la réservation (logement, dates, plateforme), ne propose plus
   de réserver, et ne donne toujours aucun code avant la veille de l'arrivée (`knownBookingRules` dans `prompts.js`).
3. **Nouvelle commande `/sejour [jours]`** : séjours en cours et à venir (30 jours par défaut, 365 au maximum), avec logement, voyageur, plateforme, dates,
   numéro de réservation et téléphone si connu. Ajoutée à `/aide`.

## Découpage
`server.js` (point d'entrée inchangé : `node server.js`) + `src/` en 19 modules. Tous les exports de l'ancien fichier sont conservés
(80 comparaisons identiques ancien/nouveau sur les fonctions pures). `package.json`, `public/` et le fichier d'état ne changent pas de place.

## Corrections
1. Vérification WhatsApp : un numéro écrit dans le message ne compte plus ; seul le numéro réel de l'expéditeur compte comme « téléphone ».
2. Jeton Telegram : plus jamais écrit dans les logs (`scrub`).
3. `/pause` : les messages du voyageur (texte ou autre) sont transférés au propriétaire avec les commandes `/repondre` et `/reprise`.
4. `/repondre` : destinataire obligatoire (plus de dernière conversation par défaut). `/pause` et `/reprise` gardent le défaut.
5. Chat web : seuls les messages du visiteur sont lus (10 derniers). Filet en sortie : digicode / Wi-Fi / codes jamais renvoyés.
6. Anciens voyageurs : email exact et réel, statut `confirmed`, séjours déjà commencés, sans blocages ni doublons, cache 30 min.
   Nouvelles variables : `FORMER_GUEST_STATUSES`, `FORMER_GUEST_PAST_ONLY=off`.
7. Adresse : filtre durci (apostrophes, espaces, « lindustrie », n°, bis, St-Quentin, anglais, caractères invisibles).

## À savoir
- `sanitizeChatMessages` ne renvoie plus que des tours « user » : adapter un éventuel test qui attend des tours « assistant ».
- Les voyageurs Airbnb/Booking (adresse relais) ne sont plus comptés comme « anciens » (compte = 0).
- Non fait : exiger `/valider` quand le numéro diffère de la réservation ; nom + séjour deviné reste possible.

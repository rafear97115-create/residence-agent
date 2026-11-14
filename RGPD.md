# Données personnelles : assistant virtuel de la Résidence de l'Industrie

Document de travail à adapter (je ne suis pas juriste : à faire relire, notamment les contrats des prestataires). Les points marqués ⚠️ sont à vérifier de votre côté.

## 1. Texte à reprendre dans la politique de confidentialité du site

**Assistant virtuel.** Pour répondre à vos questions (site, WhatsApp, Airbnb, Booking), la Résidence utilise un assistant automatisé fondé sur l'intelligence artificielle.
Il ne prend aucune décision à votre place : les demandes particulières (tarifs, réclamations, urgences) sont transmises à un membre de l'équipe.

**Données traitées.** Le contenu de vos messages ; votre numéro WhatsApp ; pour les voyageurs : nom, dates de séjour, logement, plateforme et numéro de réservation, lus dans notre outil de gestion (Beds24) pour vous reconnaître et vous répondre.

**Finalités.** Répondre aux demandes ; communiquer les informations d'accès aux voyageurs dont l'identité est vérifiée ; prévenir le propriétaire en cas d'urgence ou de demande particulière ; protéger l'accès aux logements (blocage après tentatives d'identification répétées).

**Base légale.** Exécution du contrat de location (informations de séjour, accès) et intérêt légitime (répondre aux demandes, sécurité des logements). ⚠️ À confirmer par votre conseil.

**Destinataires et prestataires.** Anthropic (intelligence artificielle : reçoit le texte des messages et, pour un voyageur vérifié, les informations utiles à la réponse) ; Meta / WhatsApp (messagerie) ; Beds24 (gestion des réservations) ; Render (hébergement du service) ; Telegram (alertes au propriétaire, si activé).
⚠️ Vérifier pour chacun : l'accord de traitement des données (DPA), le lieu de traitement, les transferts hors Union européenne (clauses contractuelles types ou équivalent) et si les messages servent ou non à entraîner des modèles.

**Durées de conservation.**
- Texte des messages : conversation WhatsApp gardée en mémoire du service 24 h au maximum (10 derniers messages), jamais écrite dans les journaux (sauf activation volontaire de `LOG_CONTENT`) ; messages Airbnb / Booking : conservés par la plateforme et par Beds24 selon leurs propres règles.
- Fichier d'état du service : numéro WhatsApp, numéro de réservation, indicateurs « vérifié » / « bloqué » : 30 jours après le dernier message pour un voyageur vérifié ; durée du blocage + 10 jours (90 + 10 par défaut) pour un numéro bloqué. Aucun texte de message ni nom n'y figure.
- Alertes au propriétaire (WhatsApp / Telegram) : contiennent nom, téléphone et message ; à supprimer de ces messageries selon votre politique interne.

**Vos droits.** Accès, rectification, effacement, opposition, limitation, portabilité : contact ⚠️ [adresse email à indiquer]. Réclamation possible auprès de la CNIL (cnil.fr).

## 2. Registre des traitements (modèle)

| Traitement | Données | Personnes | Finalité | Destinataires | Conservation |
|---|---|---|---|---|---|
| Réponses automatiques (WhatsApp) | numéro, messages, nom/dates/logement si vérifié | voyageurs, prospects | répondre, donner l'accès | Anthropic, Meta, Beds24, Render | mémoire 24 h ; état 30 j (vérifié) |
| Réponses automatiques (Airbnb / Booking) | messages, nom, dates, logement | voyageurs | répondre | Anthropic, Beds24 | non conservé par le service (plateformes : leurs règles) |
| Chat du site | messages (aucune identité demandée) | visiteurs | répondre | Anthropic, Render | non conservé par le service ; navigateur du visiteur : session |
| Sécurité (blocages) | numéro, compteur d'échecs | utilisateurs WhatsApp | éviter la devinette de codes | Render | 100 jours (blocage + 10) |
| Alertes propriétaire | nom, téléphone, message | voyageurs, prospects | traiter les demandes | Meta, Telegram | selon votre politique |

## 3. Réglages qui aident
- `PRIVACY_URL` : lien vers votre page « données personnelles », cité dans le premier message du bot.
- Widget du site : `data-privacy="https://…"` pour afficher le lien sous la fenêtre de chat.
- `LOG_CONTENT` : laisser désactivé (par défaut).
- `LOCK_DAYS` : durée du blocage (90 jours par défaut) ; la réduire réduit aussi la conservation des numéros bloqués.
- Informer vos voyageurs (message d'arrivée, annonces) que les réponses sont données par un assistant automatisé.

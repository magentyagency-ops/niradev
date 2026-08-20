# Nira Dev

Outil de pilotage pour l'équipe technique : le manager de projet y dépose son **brief**, découpe le travail en **tâches**, l'équipe avance sur un **board** façon Jira/Trello, pose ses questions à un **assistant** qui connaît le projet, et **livre son code** — lequel est confronté automatiquement au brief et aux critères d'acceptation avant d'être validé.

Même socle technique que Nira CRM : Vite + TypeScript sans framework, Supabase (auth + Postgres + RLS), fonctions serverless Vercel, et la même grammaire visuelle « verre » à quatre thèmes — avec un accent indigo pour ne jamais confondre les deux outils.

---

## Les rôles

| Rôle | Ce qu'il peut faire |
| --- | --- |
| **Admin** | Crée et supprime les comptes, désigne les managers, voit tous les projets. **Il est manager par défaut** sur tout. |
| **Manager de projet** | Crée ses projets, rédige et publie le brief, crée et assigne les tâches, gère l'équipe affectée. |
| **Développeur** | Voit les projets sur lesquels il est affecté, fait avancer ses tâches, commente, livre son code, interroge l'assistant. |

Le cloisonnement n'est pas qu'affaire d'interface : il est appliqué par la RLS Postgres. Un développeur qui appellerait l'API directement ne verrait toujours que ses projets.

---

## Le cycle de travail

1. **Le manager crée un projet** et coche les membres de l'équipe. Seuls ces comptes verront le projet.
2. **Il rédige le brief** : contexte, objectifs, périmètre, hors périmètre, contraintes, notes techniques, livrables, et surtout des **critères d'acceptation vérifiables**. S'il n'a que des notes brutes (mail client, compte-rendu), le bouton *Structurer des notes* les range dans les bonnes sections — il relit et publie. Publier crée une **version** : l'équipe garde la trace de ce sur quoi elle a travaillé.
3. **Il découpe le brief en tâches**, à la main ou via *Découper le brief* qui propose un plan à cocher. Chaque tâche porte ses propres critères d'acceptation.
4. **Les développeurs avancent** sur le board (glisser-déposer), commentent, signalent leurs blocages, comptabilisent leur temps.
5. **Une fonctionnalité terminée est livrée** : le développeur colle son code (ou dépose ses fichiers), choisit la tâche concernée. La tâche passe en *En revue*.
6. **La revue automatique** confronte le code au brief et aux critères de la tâche, et rend un verdict argumenté : chaque critère est marqué rempli ou non avec sa justification, les défauts sont classés critical / major / minor, et un score de conformité sur 100 est attribué.
   - verdict *conforme* → la tâche passe en **Terminé** ;
   - verdict *corrections demandées* ou *non conforme* → la tâche **retourne au développeur** avec le détail de ce qui manque.
7. **L'assistant** répond aux questions de l'équipe en s'appuyant sur le brief, les tâches et l'équipe réels du projet — et dit explicitement quand l'information ne figure pas au brief plutôt que d'inventer une exigence.

---

## Installation

```bash
npm install
cp .env.example .env   # puis renseigner les clés
```

### 1. Base de données

Dans l'éditeur SQL de Supabase, exécuter `supabase/schema.sql`. Le script est **idempotent** (rejouable) et **additif** : lancé sur le projet Supabase de Nira CRM, il réutilise la table `profiles` existante et ne touche à aucune table du CRM.

Le premier compte créé — ou celui portant l'email défini dans `dev_bootstrap_admin_email()` — devient administrateur.

### 2. Variables d'environnement

| Variable | Où | Rôle |
| --- | --- | --- |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | client | Connexion et lecture, bridées par la RLS |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | serveur | Administration des comptes. **Jamais préfixé `VITE_`** |
| `OPENAI_API_KEY` | serveur | Assistant, revue de code, brief, plan de tâches |
| `OPENAI_MODEL` | serveur | `gpt-4o` par défaut ; repli automatique sur `gpt-4o-mini` si le modèle n'est pas accessible |

La clé de service Supabase se trouve dans *Project Settings → API → service_role*. Sans elle, tout fonctionne sauf l'écran **Comptes**.

### 3. Lancer

```bash
npm run dev
```

- interface : http://127.0.0.1:5200
- API locale : http://127.0.0.1:5201 (état : `/api/health`)

`npm run dev` démarre les deux : Vite pour l'interface, et un petit serveur Express qui monte **exactement les mêmes fichiers** que `api/`. Ce qui est testé en local est donc ce qui est déployé — les handlers n'ont aucune branche « dev ».

---

## Structure

```
index.html            coquille de l'application (toutes les vues)
src/
  main.ts             démarrage, navigation, sélecteur de projet, thèmes, session
  store.ts            état en mémoire, rôles, sélecteurs, abonnement au rendu
  api.ts              lectures/écritures Supabase
  adminApi.ts         client de /api/admin/users
  aiApi.ts            client des fonctions IA
  auth.ts             session, profil, mots de passe
  forms.ts            formulaires projet / tâche / livraison / profil, plan de tâches
  drawer.ts           fiche détaillée d'une tâche
  modal.ts            modales, tiroir, confirmation
  ui.ts               référentiels (statuts, priorités…), formatage, helpers DOM
  styles.css          design system : jetons, quatre thèmes, composants
  views/              dashboard · projects · brief · board · tasks · reviews · assistant · admin
api/
  _lib/               client service_role, autorisation, appel OpenAI, contexte projet
  admin/users.ts      création, rôles, révocation, suppression des comptes
  ai/chat.ts          assistant ancré sur le projet
  ai/review.ts        revue de code face au brief
  ai/brief.ts         mise en forme de notes brutes en brief
  ai/plan.ts          découpage du brief en tâches
  ai/standup.ts       point d'avancement du tableau de bord
server/dev.ts         serveur local qui monte les fonctions ci-dessus
supabase/schema.sql   tables, RLS, triggers, vue d'avancement
```

## Raccourcis clavier

| Touche | Action |
| --- | --- |
| `n` | Nouvelle tâche (managers) |
| `l` | Livrer du code |
| `a` | Ouvrir l'assistant |
| `Échap` | Fermer la modale ou le tiroir |

## Points de sécurité

- La clé OpenAI et la clé `service_role` ne quittent jamais le serveur : le navigateur n'envoie qu'un identifiant de projet ou de livraison, et le serveur reconstitue lui-même le contexte **après** avoir vérifié les droits de l'appelant.
- Un compte ne peut pas se promouvoir : un trigger Postgres réécrit `role`, `dev_role`, `dev_access` et `active` à leur ancienne valeur pour tout appelant non-admin.
- Un administrateur ne peut pas retirer ses propres droits ni supprimer son propre compte, pour qu'une instance ne se retrouve jamais sans administrateur.
- Supprimer un compte ne détruit rien : ses tâches et les projets qu'il gérait sont transférés à l'administrateur avant suppression.

# Déploiement de Nira Dev

## 1. Supabase

1. Utiliser le projet Supabase existant (celui de Nira CRM) **ou** en créer un nouveau.
2. Ouvrir *SQL Editor* → coller le contenu de `supabase/schema.sql` → *Run*.
   Le script est idempotent : en cas de doute, le rejouer ne casse rien.
3. Vérifier dans *Table Editor* que `projects`, `briefs`, `tasks`, `submissions`, `reviews`, `activity`, `chat_messages` et `project_members` existent.
4. Dans *Authentication → Providers*, s'assurer que « Email » est activé. Les comptes étant créés par l'administrateur, on peut désactiver les inscriptions publiques (*Authentication → Sign In / Providers → Allow new users to sign up*).

### Le premier administrateur

- Si le projet Supabase est neuf : créer un compte via *Authentication → Users → Add user* avec `clarence@nira-ia.com`. Le trigger lui attribue le rôle `admin`.
- Si le projet est partagé avec le CRM : les comptes admin du CRM deviennent automatiquement admin de Nira Dev (`update ... where role = 'admin'` dans le script). Les autres comptes existants arrivent en rôle `dev` avec accès activé — les révoquer depuis l'écran **Comptes** s'ils ne font pas partie de l'équipe technique.

## 2. Vercel

```bash
npx vercel        # première fois : lier le projet
npx vercel --prod
```

Variables d'environnement à déclarer dans *Settings → Environment Variables* (Production **et** Preview) :

| Nom | Valeur |
| --- | --- |
| `VITE_SUPABASE_URL` | URL du projet Supabase |
| `VITE_SUPABASE_ANON_KEY` | clé `anon` |
| `SUPABASE_URL` | même URL, sans le préfixe `VITE_` |
| `SUPABASE_SERVICE_ROLE_KEY` | clé `service_role` (**secrète**) |
| `OPENAI_API_KEY` | clé OpenAI (**secrète**) |
| `OPENAI_MODEL` | `gpt-4o` (optionnel) |

⚠️ Ne jamais préfixer `SUPABASE_SERVICE_ROLE_KEY` ni `OPENAI_API_KEY` par `VITE_` : tout ce qui commence par `VITE_` est embarqué en clair dans le bundle du navigateur.

Après le premier déploiement, ajouter l'URL de production dans Supabase → *Authentication → URL Configuration → Site URL / Redirect URLs*, sinon les liens de réinitialisation de mot de passe pointeront vers `localhost`.

## 3. Vérification post-déploiement

1. Se connecter avec le compte admin.
2. **Comptes** → créer un compte manager et un compte développeur (un mot de passe de 8 caractères minimum).
   - Si l'écran affiche « Administration indisponible », `SUPABASE_SERVICE_ROLE_KEY` est absent ou erroné.
3. Créer un projet, cocher le développeur dans l'équipe.
4. Rédiger et publier un brief avec au moins deux critères d'acceptation.
5. *Découper le brief* → créer quelques tâches → en assigner une au développeur.
6. Se connecter avec le compte développeur : il ne doit voir que ce projet.
7. Livrer un bout de code sur sa tâche et vérifier que la revue rend un verdict.
   - Erreur 503 « Fonctionnalités IA indisponibles » : `OPENAI_API_KEY` n'est pas défini côté serveur.
   - Erreur 429 : quota OpenAI atteint.

## Coûts IA

Chaque appel est une requête OpenAI facturée sur la clé configurée. Ordre de grandeur avec `gpt-4o` :

| Fonction | Contexte envoyé | Coût indicatif |
| --- | --- | --- |
| Assistant (une question) | brief + tâches + 30 derniers tours de la conversation | quelques centimes |
| Revue de code | brief + tâche + code (plafonné à 120 000 caractères) | le plus coûteux : proportionnel à la taille du code |
| Structurer des notes / découper le brief | notes ou brief | faible |
| Point d'avancement | jusqu'à 5 projets | faible |

Le code livré est tronqué à 120 000 caractères (~30 k tokens) : au-delà, la revue coûterait plus qu'elle ne rapporte. Pour réduire la facture, passer `OPENAI_MODEL=gpt-4o-mini` — la revue reste utile, mais elle relève moins de défauts subtils.

## Sauvegarde

Tout vit dans Supabase. *Database → Backups* pour la sauvegarde automatique ; en plan gratuit, un export manuel régulier via `pg_dump` est prudent.

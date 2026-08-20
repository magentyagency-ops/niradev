import cors from 'cors'
import 'dotenv/config'
import express from 'express'
import type { VercelRequest, VercelResponse } from '@vercel/node'

import adminUsers from '../api/admin/users.js'
import aiBrief from '../api/ai/brief.js'
import aiChat from '../api/ai/chat.js'
import aiPlan from '../api/ai/plan.js'
import aiReview from '../api/ai/review.js'
import aiStandup from '../api/ai/standup.js'

/**
 * Serveur de développement local.
 *
 * En production, Vercel exécute directement les fichiers de `api/`. En local,
 * ce petit serveur monte exactement les mêmes fonctions : le code des handlers
 * n'a donc aucune branche « dev » et ce qui est testé ici est ce qui sera déployé.
 */

type Handler = (request: VercelRequest, response: VercelResponse) => Promise<void> | void

const app = express()
app.use(cors())
// Une livraison de code peut peser plusieurs centaines de kilo-octets.
app.use(express.json({ limit: '8mb' }))

const mount = (path: string, handler: Handler): void => {
  app.all(path, (request, response) => {
    void Promise.resolve(handler(request as unknown as VercelRequest, response as unknown as VercelResponse)).catch(
      (error: Error) => {
        console.error(`[dev-api] ${path}`, error)
        if (!response.headersSent) response.status(500).json({ error: error.message })
      },
    )
  })
}

mount('/api/admin/users', adminUsers as Handler)
mount('/api/ai/chat', aiChat as Handler)
mount('/api/ai/review', aiReview as Handler)
mount('/api/ai/brief', aiBrief as Handler)
mount('/api/ai/plan', aiPlan as Handler)
mount('/api/ai/standup', aiStandup as Handler)

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_MODEL || 'gpt-4o',
  })
})

const port = Number(process.env.API_PORT ?? 5201)
app.listen(port, '127.0.0.1', () => {
  console.log(`[nira-dev] API locale sur http://127.0.0.1:${port}`)
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[nira-dev] SUPABASE_SERVICE_ROLE_KEY absent : /api/admin/users renverra une erreur 500.')
  }
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[nira-dev] OPENAI_API_KEY absent : les fonctions IA renverront une erreur 503.')
  }
})

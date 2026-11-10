// Reads and saves of existing recipe cards stay available. Only retired entry,
// questionnaire and generation routes are closed, including cached clients.
export function isRetiredRecipeRoute(path, method) {
  return method === 'POST' && /^\/api\/(?:recipe-request(?:\/transcribe)?|suggestions)$/.test(path)
    || /^\/api\/dinner\/(?:tastes|profile|open|request|onboarding\/start|recommend|reject-batch|next|prefetch)$/.test(path)
    || /^\/api\/dinner\/recommendations\/[^/]+\/(?:reject|reason|replace)$/.test(path)
    || /^\/api\/notifications\/[^/]+\/(?:open|select)$/.test(path);
}

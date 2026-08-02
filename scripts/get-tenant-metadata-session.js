
// devconsole

// Tenant meta (any member): flags bit 0 = LLM key present
const s = await (await fetch('/api/status', { credentials: 'include' })).json();
s.tenantMeta;                                   // { flags: 1, llmProvider: "anthropic" }
(s.tenantMeta.flags & 1) === 1;                 // true = key on file for the active text vendor

// Owner session required for the two admin reads
const ai = await (await fetch('/api/admin/ai-config', { credentials: 'include' })).json();
ai.providers.map(p => [p.id, p.textGeneration, p.textGenerationNotice]);   // 2.6.1 + 2.6.5 fields
ai.current;                                     // { provider, model, hasKey } (hasKey predates 2.6.1)

const img = await (await fetch('/api/admin/image-model', { credentials: 'include' })).json();
img.current;                                    // { provider, model, hasKey }  hasKey new in 2.6.1



import type { Register } from 'claude-code'

// Regra do CLAUDE.md, agora mecânica: subagente para busca, leitura e auditoria roda no Sonnet.
// Esquecer o modelo herdava o Opus da conversa (a skill de workflows manda omitir o modelo).
// Opus continua possível: basta escrevê-lo de propósito.

// Tipos embutidos que já têm modelo próprio ou não são trabalho de leitura: não mexer.
const PROPRIOS = new Set(['Explore', 'Plan', 'claude-code-guide', 'statusline-setup'])

async function registrar($: any, linha: string) {
  const base = (await $.env.get('LOCALAPPDATA')) ?? (await $.env.get('TMPDIR')) ?? '/tmp'
  const dir = `${String(base).replace(/\\/g, '/')}/sonnet-por-padrao`
  const arq = `${dir}/decisoes.log`
  const antes = await $.fs.read(arq).catch(() => '')
  const linhas = String(antes ?? '').split('\n').filter(Boolean).slice(-199)
  await $.fs.write(arq, [...linhas, `${new Date(await $.clock.now()).toISOString()} ${linha}`].join('\n') + '\n').catch(() => undefined)
}

// Agentes de script (ferramenta Workflow) não passam pelo agent.spawn: o script ganha uma camada
// que dá Sonnet a todo agent() sem modelo. Modelo escrito (inclusive opus) passa intacto.
const CAMADA_INICIO = 'return await (async (agent) => {\n'
const CAMADA_FIM = "\n})((p, o) => agent(p, { ...(o || {}), model: (o && o.model) || 'sonnet' }))\n"

// Fim do `export const meta = {...}` (literal puro, exigido no topo do script).
function fimDoMeta(s: string): number {
  const i = s.search(/export\s+const\s+meta\s*=\s*\{/)
  if (i < 0) return -1
  let prof = 0
  let aspas = ''
  for (let k = s.indexOf('{', i); k < s.length; k++) {
    const c = s[k]
    if (aspas) { if (c === '\\') k++; else if (c === aspas) aspas = ''; continue }
    if (c === '"' || c === "'" || c === '`') aspas = c
    else if (c === '{') prof++
    else if (c === '}' && --prof === 0) return k + 1
  }
  return -1
}

export function envolver(script: string): string {
  if (script.includes(CAMADA_FIM.trim())) return script
  const f = fimDoMeta(script)
  if (f < 0) return script
  return script.slice(0, f) + '\n' + CAMADA_INICIO + script.slice(f) + CAMADA_FIM
}

export const register: Register = on => {
  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const a: any = e
    if (typeof a.script !== 'string' || !a.script.trim()) return next(e)
    const novo = envolver(a.script)
    await registrar($, `${novo === a.script ? 'script mantido' : 'SCRIPT com camada sonnet'} ${a.script.length} caracteres`)
    return next(novo === a.script ? e : { ...a, script: novo })
  })

  on('agent.spawn', async ($, e, next) => {
    const trocar = !e.fork && !e.model && e.provider.plugin === 'engine' && !PROPRIOS.has(e.subagentType)
    await registrar($, `${trocar ? 'SONNET' : 'mantido'} tipo=${e.subagentType} modelo=${e.model ?? '-'} pai=${e.parentModel} desc=${e.description}`)
    return next(trocar ? { ...e, model: 'sonnet' } : e)
  })
}

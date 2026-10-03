import type { Register } from 'claude-code'

// Revisor por LLM tende a achar defeito em trabalho correto, e o Claude tende a aceitar a crítica
// sem conferir (estudos de 2025-2026). O lembrete entra só no resultado de um revisor, não em toda mensagem.

// Codex (plugin oficial, codex exec das skills), agy (call-agy) e o motor do /llm-council.
const REVISOR = /codex-companion|\bcodex(\.exe)?\s+exec\b|agy\.py|council\.py/i

const LEMBRETE = `[revisor-com-prova] Se este resultado traz crítica ou achados, cada achado é candidato, não fato:
- só vale com prova (teste ou comando que falha, medida, ou cenário concreto com arquivo:linha); sem prova, é opinião;
- reproduza antes de corrigir e diga ao usuário o que descartou e por quê;
- requisito que o usuário não pediu não é defeito; "aprovado sem achados" é resultado válido;
- nova rodada só para achado grave; não reabra o que já foi decidido.`

// Texto de heredoc é dado, não comando: um script que só cita "council.py" não chamou revisor nenhum.
const semHeredoc = (cmd: string) => cmd.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(?=\n|$)/g, '')

export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    const r: any = await next(e)
    if (r?.deny !== undefined || r?.isError === true) return r
    const a: any = e
    const deRevisor =
      ((e.tool === 'Bash' || e.tool === 'PowerShell') && REVISOR.test(semHeredoc(String(a.command ?? '')))) ||
      (e.tool === 'Agent' && /codex/i.test(String(a.subagent_type ?? '')))
    if (!deRevisor) return r
    return { ...r, context: [...(r.context ?? []), LEMBRETE] }
  })
}

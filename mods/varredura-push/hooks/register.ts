import type { Register } from 'claude-code'

// O verificador roda DENTRO do comando, logo antes do push: assim enxerga o que o próprio
// comando criou, adicionou e commitou antes. A lógica de busca mora no script, que vem junto com o mod.
// Liberação pontual, só com o "pode subir" do usuário na conversa.
const LIBERA = /\bVARREDURA_OK=1\b/

const GIT_PUSH = /\bgit\b((?:\s+-C\s+(?:"[^"]+"|'[^']+'|[^\s;&|]+))?)[^;&|\n]*?\bpush\b/g
const GH_PUBLICA = /\bgh\s+(?:repo\s+create\b[^;&|\n]*--push|release\s+create\b|repo\s+edit\b[^;&|\n]*--visibility\s+public)/g

// Trechos de heredoc são dado, não comando: um script que só cita "git push" não publica nada.
function trechosDeHeredoc(cmd: string): [number, number][] {
  const out: [number, number][] = []
  for (const m of cmd.matchAll(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(?=\n|$)/g))
    out.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
  return out
}

function inserirVerificador(cmd: string, SCRIPT: string): string {
  const fora = trechosDeHeredoc(cmd)
  const dentro = (i: number) => fora.some(([a, b]) => i > a && i < b)
  let n = 0
  const comPush = cmd.replace(GIT_PUSH, (m, menosC: string, i: number) => {
    if (dentro(i)) return m
    n++
    return `${SCRIPT}${menosC ?? ''} && ${m}`
  })
  const tudo = comPush.replace(GH_PUBLICA, (m, i: number) => {
    if (dentro(i)) return m
    n++
    return `${SCRIPT} && ${m}`
  })
  return n ? tudo : cmd
}

export const register: Register = on => {
  // Bash e PowerShell (7+, que entende &&): push por qualquer um dos dois passa pela varredura.
  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Bash' && e.tool !== 'PowerShell') return next(e)
    const cmd = String((e as any).command ?? '')
    if (LIBERA.test(cmd)) return next(e)
    // No Windows o Python atende por "python"; no macOS e no Linux, por "python3".
    const python = (await $.env.get('OS')) === 'Windows_NT' ? 'python' : 'python3'
    const script = `${python} "${String($.plugin.root).replace(/\\/g, '/')}/varredura.py"`
    const novo = inserirVerificador(cmd, script)
    if (novo === cmd) return next(e)
    const r: any = await next({ ...e, command: novo } as any)
    const saida = JSON.stringify(r ?? '')
    if (saida.includes('varredura-push barrou')) $.ui.toast('varredura: push barrado, veja os achados')
    return r
  })
}

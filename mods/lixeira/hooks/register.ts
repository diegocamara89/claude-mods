import type { Register } from 'claude-code'

// Troca o apagar de vez pela lixeira do sistema e barra o que não tem volta.
// Ideias de leitura de comando (aspas, sudo/env, alvos seguros) do launch-codes, OneWave AI (MIT):
// https://github.com/OneWave-AI/claude-code-mods/tree/main/launch-codes
const LIBERA = /\bLIXEIRA_OK=1\b/

// Temporários e caches: apagar ali não perde trabalho.
const SEGURO = /(^|[\\/])\$?\{?(temp|tmp|scratchpad|node_modules|__pycache__|\.pytest_cache|\.cache|\.mypy_cache|\.ruff_cache|\.next|\.turbo|dist|coverage)([\\/]|$)/i

const SEM_VOLTA: [RegExp, string][] = [
  [/\bformat(\.com)?\s+[a-z]:/i, 'formatar disco'],
  [/\bdiskpart\b/i, 'diskpart'],
  [/\bClear-RecycleBin\b|\$Recycle\.Bin/i, 'esvaziar a lixeira'],
  [/\bgit\b[^;&|\n]*\breset\b[^;&|\n]*--hard\b/, 'git reset --hard'],
  [/\bgit\b[^;&|\n]*\bpush\b[^;&|\n]*(--force(?!-with-lease)\b|\s-f\b)/, 'git push --force'],
  [/\bgit\b[^;&|\n]*\bclean\b[^;&|\n]*\s-[a-z]*f/, 'git clean -f'],
  [/\b(shred|sdelete)\b|\bcipher\s+\/w/i, 'apagar sem recuperação'],
  [/\bmkfs\b|\bdd\b[^;\n]*\bof=/, 'sobrescrever disco'],
]

type Palavra = { w: string } | { op: string }

// Divide em palavras e operadores respeitando aspas: texto entre aspas não vira comando.
function palavras(linha: string): Palavra[] {
  const out: Palavra[] = []
  let w = '', tem = false
  const fecha = () => { if (tem) out.push({ w }); w = ''; tem = false }
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i]
    if (c === "'" || c === '"') {
      const fim = linha.indexOf(c, i + 1)
      w += linha.slice(i + 1, fim === -1 ? linha.length : fim); tem = true
      i = fim === -1 ? linha.length : fim
    } else if (c === ' ' || c === '\t') fecha()
    else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') { fecha(); out.push({ op: c }) }
    else { w += c; tem = true }
  }
  fecha()
  return out
}

function comandos(linha: string): string[][] {
  const out: string[][] = []
  let atual: string[] = []
  for (const p of palavras(linha)) {
    if ('op' in p) { if (atual.length) out.push(atual); atual = [] }
    else atual.push(p.w)
  }
  if (atual.length) out.push(atual)
  return out
}

const PULA = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'xargs'])
function programa(ws: string[]) {
  let i = 0
  while (i < ws.length && (PULA.has(ws[i]) || /^[A-Za-z_]\w*=/.test(ws[i]))) i++
  return { nome: (ws[i] ?? '').split(/[\\/]/).pop()!.toLowerCase(), args: ws.slice(i + 1) }
}

// Alvos de cada comando que apaga, nas duas sintaxes (Bash e PowerShell/cmd).
function alvosQueApagam(cmd: string): string[] {
  const alvos: string[] = []
  for (const ws of comandos(cmd)) {
    const { nome, args } = programa(ws)
    const semFlag = args.filter(a => !/^(-|\/[a-z]$)/i.test(a) && !/^-(Recurse|Force|Path|LiteralPath|Confirm:\$false)$/i.test(a))
    if (['rm', 'unlink'].includes(nome)) alvos.push(...semFlag)
    else if (['remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir'].includes(nome)) {
      if (nome === 'rmdir' && !args.some(a => /^(\/s|-r|-recurse)$/i.test(a))) continue // rmdir simples só remove pasta vazia
      alvos.push(...semFlag)
    } else if (nome === 'find' && args.includes('-delete')) alvos.push(args[0] ?? '.')
    else if (['powershell', 'pwsh', 'cmd', 'bash', 'sh'].includes(nome)) {
      const i = args.findIndex(a => /^(-c|-command|\/c)$/i.test(a))
      if (i >= 0 && args[i + 1]) alvos.push(...alvosQueApagam(args.slice(i + 1).join(' ')))
    }
  }
  return alvos
}

// Arquivos que o Claude criou nesta conversa: apagar o próprio rascunho é livre.
const criados = new Set<string>()
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\/([a-z])\//i, '$1:/').toLowerCase()

export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    const a: any = e
    if (e.tool === 'Write' && a.file_path) {
      const r = await next(e)
      criados.add(norm(String(a.file_path)))
      return r
    }
    if (e.tool !== 'Bash' && e.tool !== 'PowerShell') return next(e)
    const cmd = String(a.command ?? '').replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(?=\n|$)/g, '')
    if (LIBERA.test(cmd)) return next(e)

    const semVolta = SEM_VOLTA.filter(([re]) => re.test(cmd)).map(([, nome]) => nome)
    if (semVolta.length) {
      $.ui.toast(`lixeira: barrado (${semVolta.join(', ')})`)
      return {
        deny: `lixeira barrou um comando sem volta: ${semVolta.join(', ')}.\n` +
          'Explique ao usuário o que o comando faria e peça o sim dele. Com o sim explícito nesta conversa, ' +
          'repita com LIXEIRA_OK=1 na frente. Nunca por conta própria.',
      }
    }

    const perigosos = alvosQueApagam(cmd).filter(t => t && !SEGURO.test(t) && !criados.has(norm(t)))
    if (!perigosos.length) return next(e)
    $.ui.toast('lixeira: troquei o apagar pela lixeira')
    const lista = perigosos.map(t => `"${t}"`).join(' ')
    // Windows: script que vem junto com o mod. macOS e Linux: o comando de lixeira do sistema.
    const windows = (await $.env.get('OS')) === 'Windows_NT'
    const script = `${String($.plugin.root).replace(/\\/g, '/')}/lixeira.ps1`
    const como = windows
      ? `Mande para a Lixeira do Windows (dá para restaurar):\npowershell -NoProfile -ExecutionPolicy Bypass -File "${script}" ${lista}\n`
      : `Mande para a lixeira do sistema (dá para restaurar): trash ${lista} (macOS 14+ ou pacote trash-cli) ou gio trash ${lista} (Linux).\n`
    return {
      deny: `lixeira: este comando apagaria de vez ${perigosos.slice(0, 5).join(', ')}${perigosos.length > 5 ? '…' : ''}.\n` +
        como +
        'Coringa (*) ou variável no caminho: troque pelo caminho real antes. Se o usuário pediu apagar de vez, ' +
        'repita com LIXEIRA_OK=1 só com o sim dele.',
    }
  })
}

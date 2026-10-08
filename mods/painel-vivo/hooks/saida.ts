// Saída dos comandos, em funções PURAS: envoltório do Bash/PowerShell, cauda e porcentagem, passos do agy,
// fases do journal do workflow. Quem lê os arquivos (com o $) é coleta.ts: o motor só segue o $ para funções
// do próprio arquivo, nunca através de import.

export const LIMITE = 3_000_000 // acima disto não lê: o $.fs não lê pedaço de arquivo
const PCT = /(\d{1,3}(?:[.,]\d+)?)\s?%/g
const NAO_PCT = /cpu|passed|desconto/i
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

const aspas = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * Bash: todo comando (fundo inclusive) exporta AGY_EVENTS_DIR, para o agy chamado por qualquer script gravar
 * os passos. Com `log` (só primeiro plano), o tee copia a saída para o registro; a saída continua indo ao Claude.
 */
export function envolverBash(cmd: string, agyDir: string, log?: string): string {
  const env = `export AGY_EVENTS_DIR=${aspas(agyDir)}; export PYTHONUNBUFFERED=1;`
  if (!log) return `${env}\n${cmd}`
  const dir = log.slice(0, log.lastIndexOf('/'))
  return `mkdir -p ${aspas(dir)} 2>/dev/null; ${env} {\n${cmd}\n} > >(tee ${aspas(log)}) 2>&1`
}

/** PowerShell: só as variáveis (sem tee). */
export function envolverPowerShell(cmd: string, agyDir: string): string {
  return `$env:AGY_EVENTS_DIR='${agyDir.replace(/'/g, "''")}'; $env:PYTHONUNBUFFERED='1'\n${cmd}`
}

/** Arquivo de saída de um comando em segundo plano, dito no texto do resultado. */
export function arquivoDeSaida(texto: string): string | undefined {
  return /Output is being written to: (\S.*?\.output)/.exec(texto)?.[1]?.replace(/\\/g, '/')
}

/** Porcentagem só de linha com cara de progresso ("63%", "[####  ] 63%", "63.0%|"); ignora CPU, testes, descontos. */
export function porcentagem(linhas: string[]): number | undefined {
  for (const l of linhas.slice(-3).reverse()) {
    if (NAO_PCT.test(l)) continue
    const achados = [...l.matchAll(PCT)].map(m => parseFloat(m[1]!.replace(',', '.'))).filter(n => n <= 100)
    if (achados.length) return achados[achados.length - 1]
  }
  return undefined
}

/** Últimas 12 linhas (sem cores ANSI) e a porcentagem do texto de um registro. */
export function caudaDe(texto: string): { cauda: string[]; pct?: number } {
  const linhas = texto.slice(-6000).split(/\r|\n/).map(l => l.replace(ANSI, '').trimEnd()).filter(l => l.trim() !== '')
  const pct = porcentagem(linhas)
  return { cauda: linhas.slice(-12), ...(pct !== undefined ? { pct } : {}) }
}

export type PassosAgy = { modelo: string; passos: number; agora: string; fim: boolean; ok: boolean; tokens: number }

/** Tokens do agy: cada passo informa `usage.total_tokens`; no fim vem um passo com o total acumulado
 * (igual à soma dos anteriores, medido em 08/10). Esse não soma de novo. */
export function somaTokensAgy(totais: number[]): number {
  const ant = totais.slice(0, -1).reduce((s, n) => s + n, 0)
  const ult = totais[totais.length - 1] ?? 0
  return totais.length > 1 && ult === ant ? ult : ant + ult
}

function primeiroParametro(p: any): string {
  if (!p || typeof p !== 'object') return ''
  const v = p.CommandLine ?? p.command ?? p.AbsolutePath ?? p.path ?? p.Query ?? p.query ?? Object.values(p)[0]
  return String(v ?? '').replace(/\s+/g, ' ').slice(0, 120)
}

/** Um arquivo de eventos do agy (stream-json, um por chamada): modelo, passos, passo atual ("view_file: x"), fim. */
export function lerEventosAgy(texto: string): PassosAgy {
  const a: PassosAgy = { modelo: '', passos: 0, agora: 'começando', fim: false, ok: false, tokens: 0 }
  const totais: number[] = []
  for (const linha of texto.split('\n')) {
    let ev: any
    try { ev = JSON.parse(linha) } catch { continue }
    if (ev.event === 'init') a.modelo = String(ev.init?.model ?? '')
    if (ev.event === 'step_update') {
      const u = ev.step_update ?? {}
      a.passos = Math.max(a.passos, Number(u.step_index ?? 0) + 1)
      if (u.usage?.total_tokens) totais.push(Number(u.usage.total_tokens))
      if (u.step_type === 'tool') a.agora = `${u.tool_name}: ${primeiroParametro(u.tool_info?.parameters)}`
      else if (u.step_type === 'agent_response') a.agora = u.state === 'ACTIVE' ? 'escrevendo a resposta' : 'pensando'
    }
    if (ev.event === 'result') {
      a.fim = true
      a.ok = !/error/i.test(String(ev.result?.status ?? ''))
      a.agora = 'concluído'
    }
  }
  a.tokens = somaTokensAgy(totais)
  return a
}

/** Fase de cada agente de um workflow, pelas linhas `started` do journal.jsonl. */
export function fasesDoJornal(texto: string): Record<string, string> {
  const fases: Record<string, string> = {}
  for (const linha of texto.split('\n')) {
    let d: any
    try { d = JSON.parse(linha) } catch { continue }
    if (d.type === 'started' && d.agentId && d.phase) fases[String(d.agentId)] = String(d.phase)
  }
  return fases
}

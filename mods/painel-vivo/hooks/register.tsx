import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Agente, Agy, Chamada, Termo } from '../types'

const PANE = 'painel-vivo'
const chamadas = atom({ plugin: 'painel-vivo', key: 'chamadas' } as const, [])
const aberta = atom({ plugin: 'painel-vivo', key: 'aberta' } as const, '')
const verGlossario = atom({ plugin: 'painel-vivo', key: 'verGlossario' } as const, false)
const glossario = atom({ plugin: 'painel-vivo', key: 'glossario' } as const, [])
const agentes = atom({ plugin: 'painel-vivo', key: 'agentes' } as const, {})
// Quanto da janela de contexto a última resposta ocupou (o mesmo número da linha de status; ler é grátis).
const contexto = atom({ plugin: 'painel-vivo', key: 'contexto' } as const, { janela: 0 })
// Modelo e esforço do agente principal, lidos de cada pedido que ele faz ao modelo.
const principal = atom({ plugin: 'painel-vivo', key: 'principal' } as const, { modelo: '' })

const cota = (rl: { kind: string; percentUsed: number }[], k: string) => rl.find(r => r.kind === k)?.percentUsed
const medidas = (c: { percent?: number; tokens?: number; window: number }, rl: { kind: string; percentUsed: number }[]) =>
  ({ pct: c.percent, tokens: c.tokens, janela: c.window, cota5h: cota(rl, 'five_hour'), semana: cota(rl, 'seven_day') })

const ESFORCO: Record<string, [number, string]> = { low: [1, 'baixo'], medium: [2, 'médio'], high: [3, 'alto'], xhigh: [4, 'muito alto'], max: [5, 'máximo'] }
const esforcoTxt = (e?: string) => {
  const [n, nome] = ESFORCO[e ?? ''] ?? [0, '']
  return n ? `${'▮'.repeat(n)}${'▯'.repeat(5 - n)} ${nome}` : ''
}
const hora = (ms: number) => new Date(ms).toTimeString().slice(0, 8)
// Cor por tipo de trabalhador; o estado (erro, calado) pinta por cima.
const corDe = (c: Chamada) => (c.rotulo === 'agy' ? 'magenta' : c.rotulo === 'Codex' ? 'cyan' : c.tool === 'Agent' ? 'blue' : 'gray')

const LIMITE_FS = 3_000_000
const PCT = /(\d{1,3}(?:[.,]\d+)?)\s?%/g

let pasta = ''

async function acharPasta($: any): Promise<string> {
  if (pasta) return pasta
  const base = (await $.env.get('LOCALAPPDATA')) ?? (await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? '/tmp'
  pasta = `${String(base).replace(/\\/g, '/')}/painel-vivo/runs`
  return pasta
}

function envolver(cmd: string, dir: string, log: string): string {
  // A saída continua indo para o Claude; o tee só copia para o registro que o painel lê.
  return `mkdir -p '${dir}' 2>/dev/null; export PYTHONUNBUFFERED=1; export AGY_EVENTS_DIR='${log}.agy'; {\n${cmd}\n} > >(tee '${log}') 2>&1`
}

async function comRtk($: any, cmd: string): Promise<string> {
  // O hook do rtk só enxergaria o envoltório; então o mod pede a reescrita antes de envolver.
  const r = await $.process.run(['rtk', 'rewrite', cmd], { timeoutMs: 5000 }).catch(() => undefined)
  const out = String(r?.stdout ?? '').trim()
  return r?.exitCode === 0 && out.startsWith('rtk') ? out : cmd
}

async function proximoSlot($: any): Promise<number> {
  const n = Number((await $.store.get('slot')) ?? 0)
  await $.store.set('slot', (n + 1) % 60)
  return n
}

function resumir(e: any): { desc: string; cmd: string } {
  const desc = String(e.description ?? '')
  const alvo = e.command ?? e.file_path ?? e.pattern ?? e.path ?? e.url ?? e.query ?? e.prompt ?? ''
  const cmd = String(alvo).replace(/\s+/g, ' ').slice(0, 300)
  const curto = e.file_path || e.path ? String(e.file_path ?? e.path).split(/[\\/]/).pop() : cmd.slice(0, 60)
  return { desc: desc || `${e.tool}${curto ? ': ' + curto : ''}`, cmd }
}

function primeiroParametro(p: any): string {
  if (!p || typeof p !== 'object') return ''
  const v = p.CommandLine ?? p.command ?? p.AbsolutePath ?? p.path ?? p.Query ?? p.query ?? Object.values(p)[0]
  return String(v ?? '').replace(/\s+/g, ' ').slice(0, 120)
}

async function lerAgys($: any, dir: string, inicio: number): Promise<Agy[] | undefined> {
  const itens = await $.fs.list(dir).catch(() => undefined)
  if (!Array.isArray(itens)) return undefined
  const out: Agy[] = []
  for (const it of itens) {
    const nome = String(it.name ?? it.path ?? '')
    if (!nome.endsWith('.jsonl')) continue
    const arq = `${dir}/${nome.split(/[\\/]/).pop()}`
    const st = await $.fs.stat(arq).catch(() => undefined)
    if (!st || st.mtimeMs < inicio - 1000) continue
    const texto = String(await $.fs.read(arq).catch(() => ''))
    const a: Agy = { arquivo: arq, modelo: '', passos: 0, agora: 'começando', fim: false, status: '', mtime: st.mtimeMs }
    for (const linha of texto.split('\n')) {
      let ev: any
      try { ev = JSON.parse(linha) } catch { continue }
      if (ev.event === 'init') a.modelo = String(ev.init?.model ?? '')
      if (ev.event === 'step_update') {
        const u = ev.step_update ?? {}
        a.passos = Math.max(a.passos, Number(u.step_index ?? 0) + 1)
        if (u.step_type === 'tool') a.agora = `${u.tool_name}: ${primeiroParametro(u.tool_info?.parameters)}`
        else if (u.step_type === 'agent_response') a.agora = u.state === 'ACTIVE' ? 'escrevendo a resposta' : 'pensando'
      }
      if (ev.event === 'result') { a.fim = true; a.status = String(ev.result?.status ?? ''); a.agora = 'concluído' }
    }
    out.push(a)
  }
  return out
}

async function lerCauda($: any, log: string, inicio = 0) {
  const st = await $.fs.stat(log).catch(() => undefined)
  if (!st || st.kind !== 'file') return undefined
  let texto = ''
  if (st.size <= LIMITE_FS) texto = String(await $.fs.read(log).catch(() => ''))
  else texto = (await $.process.run(['tail', '-c', '8000', log]).catch(() => ({ stdout: '' }))).stdout
  texto = texto.slice(-6000)
  const linhas = texto.split(/\r|\n/).map(l => l.trimEnd()).filter(l => l.trim() !== '')
  let pct: number | undefined
  for (const l of linhas.slice(-3).reverse()) {
    const achados = [...l.matchAll(PCT)].map(m => parseFloat(m[1].replace(',', '.'))).filter(n => n <= 100)
    if (achados.length) { pct = achados[achados.length - 1]; break }
  }
  const agys = await lerAgys($, `${log}.agy`, inicio)
  const ultimaSaida = Math.max(st.mtimeMs, ...(agys ?? []).map(g => g.mtime ?? 0))
  return { cauda: linhas.slice(-12), pct, ultimaSaida, ...(agys && agys.length ? { agys } : {}) }
}

const tempo = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}min ${s % 60}s`
}

const mil = (n: number) => (n >= 1e6 ? `${(n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi` : `${Math.round(n / 1000)} mil`)

const barra = (pct: number, largura = 20) => {
  const cheio = Math.round((pct / 100) * largura)
  return '█'.repeat(cheio) + '░'.repeat(largura - cheio) + ` ${pct.toFixed(pct % 1 ? 1 : 0)}%`
}

const SISTEMA = `Você explica, para uma pessoa leiga em programação, o que um comando de computador fez.
Escreva em português do Brasil, com precisão técnica e linguagem simples. Defina cada termo técnico em poucas palavras na primeira vez que ele aparecer. Use analogia do dia a dia só se o conceito for difícil, e no lugar da explicação, não somada a ela. No máximo 120 palavras.
Estrutura em markdown: **O que faz**, **O que a saída diz**, e **Por que deu erro** só se houve erro.
Responda APENAS um JSON válido, sem cercas de código: {"explicacao": "<markdown>", "termos": [{"termo": "<palavra>", "definicao": "<uma frase>"}]}, com até 4 termos técnicos que apareceram.`

async function explicar($: any, id: string) {
  const lista = await read($, chamadas)
  const c = lista.find(x => x.id === id)
  if (!c || c.explicando) return
  await update($, chamadas, l => l.map(x => (x.id === id ? { ...x, explicando: true } : x)))
  const prompt = [
    `Ferramenta: ${c.tool}`,
    `Descrição que o Claude deu: ${c.desc}`,
    `Comando ou alvo: ${c.cmd}`,
    `Situação: ${c.fim === undefined ? 'ainda rodando' : c.erro ? 'terminou com ERRO' : 'terminou sem erro'}`,
    `Últimas linhas da saída:\n${(c.cauda ?? []).join('\n') || '(sem saída)'}`,
  ].join('\n')
  const r = await $.model.complete({ model: 'haiku', system: SISTEMA, prompt, maxTokens: 900 })
  let explicacao = 'Não consegui explicar agora.'
  let termos: Termo[] = []
  if (r.isAnswered) {
    try {
      const j = JSON.parse(String(r.text).replace(/^```(?:json)?\s*|\s*```$/g, ''))
      explicacao = String(j.explicacao ?? explicacao)
      termos = Array.isArray(j.termos) ? j.termos.filter((t: any) => t?.termo && t?.definicao) : []
    } catch {
      explicacao = String(r.text)
    }
  } else explicacao = `Não consegui explicar (${r.reason}).`
  await update($, chamadas, l => l.map(x => (x.id === id ? { ...x, explicando: false, explicacao } : x)))
  if (termos.length) {
    await update($, glossario, g => {
      const vistos = new Set(g.map(t => t.termo.toLowerCase()))
      const novos = termos.filter(t => !vistos.has(String(t.termo).toLowerCase()))
      return [...g, ...novos.map(t => ({ termo: String(t.termo), definicao: String(t.definicao) }))]
    })
    await $.store.set('glossario', await read($, glossario))
  }
}


const vistos = atom({ plugin: 'painel-vivo', key: 'vistos' } as const, [])
const historicoAberto = atom({ plugin: 'painel-vivo', key: 'historicoAberto' } as const, false)

const MESA_MS = 5_000 // comando ganha mesa a partir daqui
const FICA_MS = 10_000 // mesa concluída fica este tempo antes de virar etiqueta

const MISSAO: Record<string, string> = {
  Explore: 'pesquisa',
  Plan: 'plano',
  'codex:codex-rescue': 'revisão',
  'claude-code-guide': 'consulta',
}
const VAZIAS = new Set([
  'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das', 'e', 'em', 'no', 'na', 'nos', 'nas',
  'se', 'que', 'com', 'para', 'por', 'pelo', 'pela', 'ao', 'à', 'só', 'todo', 'toda', 'todos', 'dois', 'duas', 'três',
  'teste', 'painel', 'seu', 'sua', 'meu', 'minha', 'esse', 'essa', 'este', 'esta', 'novo', 'nova',
])
// Ferramentas sem descrição própria: a missão é a natureza da ação.
const FERRAMENTA: Record<string, string> = {
  Read: 'leitura', Edit: 'edição', Write: 'escrita', NotebookEdit: 'edição', Grep: 'busca', Glob: 'busca',
  WebFetch: 'web', WebSearch: 'web', ToolSearch: 'ferramentas',
}
// Ferramentas da própria engrenagem: não são "o que o agente está fazendo".
const INTERNAS = new Set(['SubagentHandback', 'StructuredOutput', 'ToolSearch', 'TaskUpdate', 'TaskCreate', 'TodoWrite'])

function missao(c: Chamada): string {
  if (c.tool === 'Agent' && c.rotulo && MISSAO[c.rotulo]) return MISSAO[c.rotulo]
  if (FERRAMENTA[c.tool]) return FERRAMENTA[c.tool]
  // As descrições começam por verbo ("Baixa o áudio…"): a missão é a primeira palavra útil depois dele.
  const palavras = c.desc.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean).slice(1)
  return palavras.find(p => !VAZIAS.has(p) && p.length > 2) ?? 'tarefa'
}

function fazendo(f: Chamada): string {
  const a = nomeArquivo(f.cmd)
  if (f.tool === 'Read') return `lendo ${a}`
  if (f.tool === 'Edit' || f.tool === 'NotebookEdit') return `editando ${a}`
  if (f.tool === 'Write') return `escrevendo ${a}`
  if (f.tool === 'Grep') return 'procurando um texto'
  if (f.tool === 'Glob') return 'listando arquivos'
  if (f.tool === 'WebFetch' || f.tool === 'WebSearch') return 'pesquisando na internet'
  return f.desc
}

function modeloCurto(m: string): string {
  const claude = /(opus|sonnet|haiku|fable)[-\s]?(\d+)?[-.]?(\d+)?/i.exec(m)
  if (claude) {
    const nome = claude[1][0].toUpperCase() + claude[1].slice(1).toLowerCase()
    return claude[2] ? `${nome} ${claude[2]}${claude[3] ? '.' + claude[3] : ''}` : nome
  }
  return m.replace(/\s*\((high|low|medium|thinking)\)/i, '').replace(/^Gemini [\d.]+ /, 'Gemini ').trim()
}

function titulo(c: Chamada, g?: Agy): string {
  const quem = g ? modeloCurto(g.modelo || 'Gemini')
    : c.rotulo === 'Codex' ? 'Codex'
    : c.tool === 'Agent' ? modeloCurto(c.modelo ?? 'subagente')
    : c.rotulo === 'agy' ? 'agy'
    : c.tool === 'Bash' ? 'Comando'
    : c.tool
  return `${quem} · ${missao(c)}`
}

// Passos do agy em linguagem simples, sem modelo nenhum. O que não estiver aqui aparece como veio.
const PASSOS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^run_command/, () => 'rodando um comando'],
  [/^(view_file|read_file)\S*:?\s*(.*)/, m => `lendo ${nomeArquivo(m[2]) || 'um arquivo'}`],
  [/^list_dir\S*/, () => 'listando a pasta'],
  [/^(grep_search|search_files|find_by_name)/, () => 'procurando nos arquivos'],
  [/^(write_to_file|create_file)\S*:?\s*(.*)/, m => `escrevendo ${nomeArquivo(m[2]) || 'um arquivo'}`],
  [/^(replace_file_content|edit_file|multi_replace)\S*:?\s*(.*)/, m => `editando ${nomeArquivo(m[2]) || 'um arquivo'}`],
  [/^(search_web|read_url_content|web_)/, () => 'pesquisando na internet'],
  [/^browser_/, () => 'usando o navegador'],
  [/^ask_/, () => 'esperando permissão'],
  [/^pensando/, () => 'pensando'],
  [/^escrevendo a resposta/, () => 'escrevendo a resposta'],
]

function nomeArquivo(s: string): string {
  return String(s ?? '').trim().split(/[\\/]/).pop()?.replace(/["']/g, '').slice(0, 40) ?? ''
}

function traduzir(passo: string): string {
  for (const [re, f] of PASSOS) {
    const m = re.exec(passo)
    if (m) return f(m)
  }
  return passo
}

function bolinhas(n: number, vivo: boolean): string {
  const max = 12
  const feitos = Math.min(n - (vivo ? 1 : 0), max)
  return '●'.repeat(Math.max(0, feitos)) + (vivo ? '◉' : '') + (n > max + 1 ? ` +${n - max - 1}` : '')
}

type Item = { tipo: 'uma'; c: Chamada } | { tipo: 'grupo'; n: number }

function agrupar(lista: Chamada[]): Item[] {
  const out: Item[] = []
  for (const c of lista) {
    const miuda = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'NotebookEdit', 'ToolSearch'].includes(c.tool) && !c.erro
    const ult = out[out.length - 1]
    if (miuda && ult?.tipo === 'grupo') ult.n++
    else if (miuda) out.push({ tipo: 'grupo', n: 1 })
    else out.push({ tipo: 'uma', c })
  }
  return out
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'painel', description: 'Abre o painel com o que está rodando agora' })
    await $.command.register({ name: 'glossario', description: 'Mostra o glossário de termos técnicos explicados no painel' })
    const salvo = await $.store.get('glossario')
    if (Array.isArray(salvo)) await update($, glossario, () => salvo as Termo[])
    await acharPasta($)
    const u = await $.session.usage().catch(() => undefined)
    if (u) await update($, contexto, () => medidas(u.context, u.rateLimits))
    const m = await $.session.model().catch(() => '')
    if (m) await update($, principal, p => ({ ...p, modelo: m }))
    void $.ui.open({ id: PANE, title: 'Em execução' })

    $.clock.every(1000, async () => {
      const lista = await read($, chamadas)
      if (!lista.some(c => c.fim === undefined)) return
      for (const c of lista.filter(x => x.fim === undefined && x.log)) {
        const info = await lerCauda($, c.log!, c.inicio)
        if (info && (info.ultimaSaida !== c.ultimaSaida || info.pct !== c.pct || JSON.stringify(info.agys) !== JSON.stringify(c.agys)))
          await update($, chamadas, l => l.map(x => (x.id === c.id ? { ...x, ...info } : x)))
      }
      $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  on('command.run', { command: 'painel' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Em execução' })
    return { text: 'Painel aberto.' }
  })

  on('command.run', { command: 'glossario' }, async $ => {
    const g = await read($, glossario)
    const texto = g.length
      ? g.map(t => `- **${t.termo}**: ${t.definicao}`).join('\n')
      : 'O glossário está vazio. Use "Explicar isto" no painel para começar.'
    return { text: texto }
  })

  // O motor avisa depois de cada turno; não precisa perguntar.
  on('session.measure', async ($, e, next) => {
    await update($, contexto, () => medidas(e.context, e.rateLimits))
    return next(e)
  })

  // Só observa: anota modelo e esforço de cada pedido e deixa o fluxo passar intacto.
  on('turn.step', async function* ($, e, next) {
    const esforco = e.effort === undefined ? undefined : String(e.effort)
    if (!e.agentId) {
      const p = await read($, principal)
      if (p.modelo !== e.model || p.esforco !== esforco) await update($, principal, () => ({ modelo: e.model, esforco }))
    } else {
      const ag = (await read($, agentes))[e.agentId]
      if (ag && ag.esforco !== esforco) await update($, agentes, mm => ({ ...mm, [e.agentId!]: { ...mm[e.agentId!], esforco } }))
    }
    return yield* next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r: any = await next(e)
    if (r?.agentId) {
      const ag: Agente = { pai: e.tool_use_id, tipo: e.subagentType, modelo: String(r.model ?? ''), fundo: e.background }
      await update($, agentes, m => ({ ...m, [r.agentId]: ag }))
      await update($, chamadas, l => l.map(x => (x.id === e.tool_use_id ? { ...x, modelo: ag.modelo, rotulo: ag.tipo } : x)))
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const a: any = e
    const { desc, cmd } = resumir(a)
    const c: Chamada = { id: e.tool_use_id, tool: e.tool, desc, cmd, inicio: await $.clock.now() }
    if (/codex-companion/.test(cmd)) c.rotulo = 'Codex'
    else if (/python[^;&|]*agy\.py|(^|[;&|(]\s*)agy\s/.test(cmd)) c.rotulo = 'agy'
    if (a.agentId) {
      c.agente = a.agentId
      c.pai = (await read($, agentes))[a.agentId]?.pai ?? `agente:${a.agentId}`
    }
    let entrada: any = e
    if (e.tool === 'Bash' && a.run_in_background !== true && String(a.command ?? '').trim()) {
      const dir = await acharPasta($)
      c.log = `${dir}/slot-${await proximoSlot($)}.log`
      entrada = { ...a, command: envolver(await comRtk($, String(a.command)), dir, c.log) }
    }
    await update($, chamadas, l => [...l, c].slice(-200))
    const r: any = await next(entrada)
    const fim = await $.clock.now()
    const info = c.log ? await lerCauda($, c.log, c.inicio) : undefined
    const erro = r?.deny !== undefined || r?.isError === true
    // Subagente em segundo plano: a chamada volta na hora; a linha só fecha no fim do turno dele.
    const emFundo = !erro && Object.values(await read($, agentes)).some(g => g.pai === c.id && g.fundo)
    await update($, chamadas, l =>
      l.map(x => (x.id === c.id ? { ...x, ...(info ?? {}), ...(emFundo ? {} : { fim }), erro } : x)),
    )
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const ag = e.agentId ? (await read($, agentes))[e.agentId] : undefined
    if (ag?.fundo) {
      const fim = await $.clock.now()
      const erro = e.reason !== 'answer'
      await update($, chamadas, l => l.map(x => (x.id === ag.pai && x.fim === undefined ? { ...x, fim, erro } : x)))
    }
    return r
  })


  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const lista = await read($, chamadas)
    const sel = await read($, aberta)
    const vg = await read($, verGlossario)
    const glos = await read($, glossario)
    const ctx = await read($, contexto)
    const pri = await read($, principal)
    const agentesM = await read($, agentes)
    const vistosL = await read($, vistos)
    const histAberto = await read($, historicoAberto)
    const agora = await $.clock.now()

    if (vg) {
      return (
        <Box flexDirection="column">
          <Button plain label="← voltar" onPress={() => update($, verGlossario, () => false)} />
          <Text bold>Glossário ({glos.length} termos)</Text>
          {glos.length === 0 && <Text dimColor>Vazio. Abra uma tarefa e use "Explicar isto".</Text>}
          {glos.map(t => (
            <Text>
              <Text bold>{t.termo}</Text>: {t.definicao}
            </Text>
          ))}
        </Box>
      )
    }

    const ids = new Set(lista.map(c => c.id))
    const filhos = new Map<string, Chamada[]>()
    for (const c of lista) if (c.pai && ids.has(c.pai)) filhos.set(c.pai, [...(filhos.get(c.pai) ?? []), c])
    const topo = lista.filter(c => !c.pai || !ids.has(c.pai))
    const vistosS = new Set(vistosL)
    const vida = (c: Chamada) =>
      Math.max(c.ultimaSaida ?? 0, c.inicio, ...(filhos.get(c.id) ?? []).map(f => Math.max(f.fim ?? 0, f.ultimaSaida ?? 0, f.inicio)))

    const dura = (c: Chamada) => (c.fim ?? agora) - c.inicio
    const importante = (c: Chamada) =>
      c.tool === 'Agent' || c.rotulo === 'agy' || c.rotulo === 'Codex' || (c.tool === 'Bash' && dura(c) >= MESA_MS)
    const naMesa = (c: Chamada) => importante(c) && (c.fim === undefined || agora - c.fim < FICA_MS)
    const paraVer = topo.filter(c => c.erro && !vistosS.has(c.id))
    const mesas = topo.filter(c => naMesa(c) && !(c.erro && !vistosS.has(c.id)))
    const recentes = topo.filter(c => c.fim !== undefined && importante(c) && !naMesa(c) && !(c.erro && !vistosS.has(c.id))).slice(-5).reverse()
    const noRecente = new Set([...recentes, ...mesas, ...paraVer].map(c => c.id))
    const antigos = topo.filter(c => c.fim !== undefined && !noRecente.has(c.id)).reverse()

    const trabalhando = topo.filter(c => c.fim === undefined && importante(c))
    const calados = trabalhando.filter(c => agora - vida(c) >= 10_000).length

    const abrir = (c: Chamada) => async () => {
      if (c.erro) await update($, vistos, v => (v.includes(c.id) ? v : [...v, c.id].slice(-200)))
      await update($, aberta, v => (v === c.id ? '' : c.id))
    }

    const cartao = (c: Chamada, largura: string) => {
      const vivo = c.fim === undefined
      const calado = vivo ? agora - vida(c) : 0
      const sinal = !vivo ? (c.erro ? '✕ erro' : '✓ feito') : calado < 10_000 ? 'ativo' : `calado ${tempo(calado)}`
      const corSinal = !vivo ? (c.erro ? 'red' : 'green') : calado < 10_000 ? 'green' : calado < 60_000 ? 'yellow' : 'red'
      const borda = c.erro ? 'red' : !vivo ? 'green' : calado >= 10_000 ? corSinal : corDe(c)
      const ag = c.tool === 'Agent' ? Object.values(agentesM).find(a => a.pai === c.id) : undefined
      const fs = filhos.get(c.id) ?? []
      const g = (c.agys ?? []).slice(-1)[0]
      const passos = g ? g.passos : fs.filter(f => !INTERNAS.has(f.tool)).length
      const uteis = fs.filter(f => !INTERNAS.has(f.tool))
      const filhoVivo = uteis.filter(f => f.fim === undefined).slice(-1)[0] ?? (vivo ? uteis.slice(-1)[0] : undefined)
      const agoraTxt = g && !g.fim ? traduzir(g.agora)
        : filhoVivo ? fazendo(filhoVivo)
        : c.tool === 'Agent' && vivo ? 'pensando'
        : c.rotulo === 'Codex' ? (c.cauda ?? []).filter(l => l.startsWith('[codex]')).slice(-1)[0]?.replace('[codex] ', '') ?? c.desc
        : c.desc
      return (
        <Box flexDirection="column" width={largura} borderStyle="round" borderColor={borda} paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Button plain label={titulo(c, g)} onPress={abrir(c)} />
            <Text color={corSinal}>{sinal}</Text>
          </Box>
          {ag?.esforco && <Text dimColor>{`esforço ${esforcoTxt(ag.esforco)}`}</Text>}
          <Text bold wrap="truncate-end">{agoraTxt}</Text>
          {c.pct !== undefined && vivo && <Text color="cyan">{barra(c.pct)}</Text>}
          {passos > 0 && <Text wrap="truncate-end">{bolinhas(passos, vivo)}<Text dimColor>{`  ${passos} passos · ${tempo(dura(c))}`}</Text></Text>}
          {passos === 0 && <Text dimColor>{tempo(dura(c))}</Text>}
          {c.pct === undefined && vivo && (c.cauda ?? []).length > 0 && (
            <Text dimColor wrap="truncate-end">{(c.cauda ?? []).slice(-1)[0]}</Text>
          )}
        </Box>
      )
    }

    const etiqueta = (c: Chamada, _cor?: string) => (
      <Button plain label={`${c.erro ? '✕' : '✓'} ${titulo(c, (c.agys ?? []).slice(-1)[0])} · ${tempo(dura(c))}`} onPress={abrir(c)} />
    )

    const detalhe = (c: Chamada) => {
      const fs = filhos.get(c.id) ?? []
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginTop={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold wrap="truncate-end">{c.desc}</Text>
            <Button plain label="fechar" onPress={() => update($, aberta, () => '')} />
          </Box>
          <Text dimColor wrap="truncate-end">{`${c.tool}: ${c.cmd}`}</Text>
          {fs.slice(-8).map(f => (
            <Text dimColor={f.fim !== undefined} wrap="truncate-end">{`  ${f.fim === undefined ? '▶' : f.erro ? '✕' : '✓'} ${f.desc} · ${tempo(dura(f))}`}</Text>
          ))}
          {(c.cauda ?? []).slice(-12).map(l => <Text dimColor wrap="truncate-end">{`  ${l}`}</Text>)}
          {!c.explicacao && (c.explicando
            ? <Text dimColor>explicando…</Text>
            : <Button label="Explicar isto" onPress={() => void explicar($, c.id)} />)}
          {c.explicacao && <Markdown text={c.explicacao} />}
        </Box>
      )
    }

    // Registro: cada trabalho importante entra na hora em que começou ou terminou; os 6 mais novos.
    const registro = topo.filter(importante)
      .map(c => ({ c, t: c.fim ?? c.inicio }))
      .sort((a, b) => a.t - b.t)
      .slice(-6)
    const agentesTopo = topo.filter(c => c.tool === 'Agent')
    const agVivos = agentesTopo.filter(c => c.fim === undefined).length
    const agTotal = agentesTopo.length
    const tom = (p: number) => (p >= 85 ? 'red' : p >= 70 ? 'yellow' : 'green')

    const selC = sel ? lista.find(c => c.id === sel) : undefined
    const largura = (e.props as any)?.bodyColumns ?? e.viewport?.columns ?? 80
    const duas = largura >= 70

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text bold>{trabalhando.length}</Text> trabalhando
            {calados > 0 && <Text color="yellow">{`  ·  ${calados} calado`}</Text>}
            {paraVer.length > 0 && <Text color="red">{`  ·  ${paraVer.length} ${paraVer.length > 1 ? 'erros' : 'erro'} para ver`}</Text>}
            <Text dimColor>{`  ·  ${lista.length} ações`}</Text>
          </Text>
          <Button plain label={`Glossário (${glos.length})`} onPress={() => update($, verGlossario, () => true)} />
        </Box>
        {pri.modelo && (
          <Text>
            <Text bold color="blue">{modeloCurto(pri.modelo)}</Text>
            <Text dimColor>{' · principal'}</Text>
            {pri.esforco && <Text dimColor>{`  ·  esforço `}<Text color="yellow">{esforcoTxt(pri.esforco)}</Text></Text>}
          </Text>
        )}
        <Text dimColor>
          <Text color="blue">■</Text>{' subagente  '}<Text color="gray">■</Text>{' comando  '}<Text color="magenta">■</Text>{' agy  '}
          <Text color="cyan">■</Text>{' Codex  '}<Text color="green">■</Text>{' feito  '}<Text color="red">■</Text>{' falhou'}
        </Text>

        {mesas.length === 0 && <Text dimColor>Ninguém trabalhando agora.</Text>}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {mesas.slice(-6).map(c => cartao(c, duas ? '49%' : '100%'))}
        </Box>

        {selC && detalhe(selC)}

        {paraVer.length > 0 && (
          <Box flexDirection="row" columnGap={2}>
            <Text color="red">Para ver</Text>
            <Button
              plain
              label="dispensar todos"
              onPress={() => update($, vistos, v => [...new Set([...v, ...paraVer.map(c => c.id)])].slice(-200))}
            />
          </Box>
        )}
        {paraVer.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>{paraVer.map(c => etiqueta(c, 'red'))}</Box>
        )}

        {registro.length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
            <Text dimColor>registro da sessão</Text>
            {registro.map(({ c, t }) => (
              <Box flexDirection="row" columnGap={1}>
                <Text dimColor>{hora(t)}</Text>
                <Text color={c.erro ? 'red' : corDe(c)} wrap="truncate-end">{titulo(c, (c.agys ?? []).slice(-1)[0]).split(' · ')[0].padEnd(10).slice(0, 10)}</Text>
                <Button plain label={`${c.desc}${c.fim === undefined ? ' · começou' : c.erro ? ' · falhou' : ''}`} onPress={abrir(c)} />
              </Box>
            ))}
          </Box>
        )}

        <Button
          plain
          label={`${histAberto ? '▾' : '▸'} Histórico (${antigos.length})`}
          onPress={() => update($, historicoAberto, v => !v)}
        />
        {histAberto && agrupar(antigos).slice(0, 40).map(item =>
          item.tipo === 'uma' ? (
            <Button plain label={`  ${item.c.erro ? '✕' : '✓'} ${titulo(item.c, (item.c.agys ?? []).slice(-1)[0])} · ${item.c.desc}`} onPress={abrir(item.c)} />
          ) : (
            <Text dimColor>{`  ✓ ${item.n} leituras, buscas e edições`}</Text>
          ),
        )}

        <Text>
          <Text dimColor>subagentes </Text><Text color="blue">{`[${agVivos}/${agTotal}]`}</Text>
          {ctx.pct !== undefined && <Text dimColor>{'   contexto '}<Text color={tom(ctx.pct)}>{barra(ctx.pct, 10)}</Text>{`  ${mil(ctx.tokens ?? 0)} de ${mil(ctx.janela)}`}</Text>}
          {ctx.cota5h !== undefined && <Text dimColor>{'   cota 5h '}<Text color={tom(ctx.cota5h)}>{`${ctx.cota5h}%`}</Text></Text>}
          {ctx.semana !== undefined && <Text dimColor>{'   semana '}<Text color={tom(ctx.semana)}>{`${ctx.semana}%`}</Text></Text>}
        </Text>
      </Box>
    )
  })
}

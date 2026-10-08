// Coleta: os eventos do motor viram o estado do painel. Só a coleta grava; o desenho lê por lerModelo.
// O motor só segue o $ para funções do próprio arquivo, nunca através de import: por isso tudo que usa o $
// (ganchos, relógio, ações dos botões, render) mora aqui, ligado por `ligar(on)`; register.tsx só chama ligar.
// Caminho quente (tool.call, turn.step): nada de disco, nada lento (só a reescrita do rtk chama processo).
// Arquivos (registro, passos do agy, journal) só no relógio (tique), e só para o que está rodando.

import { atom, read, update } from 'claude-code'

import type { Acao, Acoes, Modelo, Pendente, Plano, Principal, ResumoSessao, Situacao, Trabalhador, Uso, Workflow } from '../types'
import { desenharPainel } from './desenho'
import { acaoDe, horaCurta, resumoSessao, traduzirPassoAgy } from './regras'
import { LIMITE, arquivoDeSaida, caudaDe, envolverBash, envolverPowerShell, fasesDoJornal, lerEventosAgy, type PassosAgy } from './saida'
import { FRESCA, chaveSessao, ehSessao, separar, sessoesMudaram } from './sessoes'

const trabalhadores = atom({ plugin: 'painel-vivo', key: 'trabalhadores' } as const, {})
const workflows = atom({ plugin: 'painel-vivo', key: 'workflows' } as const, {})
const pendentes = atom({ plugin: 'painel-vivo', key: 'pendentes' } as const, {})
const vistos = atom({ plugin: 'painel-vivo', key: 'vistos' } as const, [])
const uso = atom({ plugin: 'painel-vivo', key: 'uso' } as const, {})
const principal = atom({ plugin: 'painel-vivo', key: 'principal' } as const, { ocupado: false, ultimoSinal: 0, tokensNovos: 0, tokensCache: 0, acoes: [] })
const sessoes = atom({ plugin: 'painel-vivo', key: 'sessoes' } as const, [])
const relogio = atom({ plugin: 'painel-vivo', key: 'relogio' } as const, 0)
const aberto = atom({ plugin: 'painel-vivo', key: 'aberto' } as const, '')
const historicoAberto = atom({ plugin: 'painel-vivo', key: 'historicoAberto' } as const, false)
const sessoesAbertas = atom({ plugin: 'painel-vivo', key: 'sessoesAbertas' } as const, false)
const verGlossario = atom({ plugin: 'painel-vivo', key: 'verGlossario' } as const, false)
const glossario = atom({ plugin: 'painel-vivo', key: 'glossario' } as const, [])

type Ts = Record<string, Trabalhador>

const PLANO = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])
const INTERNAS = new Set(['ToolSearch', 'StructuredOutput', 'SubagentHandback', 'TaskGet', 'TaskList', 'TaskOutput'])
const COMANDOS = new Set(['Bash', 'PowerShell'])
const RE_AGY = /python[^;&|]*agy\.py|(^|[;&|(]\s*)agy\s/ // casa `python run_agy.py` e `python agy.py`
const RE_CODEX = /codex-companion/
const MESA = 5_000 // comando de agente vira trabalhador a partir daqui
const MAX_TRAB = 120 // acima disto, os concluídos mais antigos saem do estado
const PANE = 'painel-vivo'

// Memória do módulo (some numa recarga, sem dano): o que o caminho quente anota e o relógio grava.
type EmVoo = { id: string; tool: string; agentId?: string; dono: string; inicio: number; rascunho?: Trabalhador; criado: boolean }
const emVoo = new Map<string, EmVoo>() // chamadas em andamento, por tool_use_id
const emPedido = new Set<string>() // agentId ('' = principal) com pedido ao modelo em curso: conta como sinal de vida
const fazendo = new Map<string, string>() // agentId → 'pensando' | 'escrevendo a resposta'
const gasto = new Map<string, { novos: number; cache: number }>() // tokens ainda não gravados, por agentId
const modelos = new Map<string, string>() // agentId → modelo visto no turn.step
const tarefas = new Map<string, Map<string, { status: string; atual?: string }>>() // TaskCreate/TaskUpdate por agente
const donos = new Map<string, string>() // agentId → id do trabalhador (também gravado em Trabalhador.agentId)
let turnoPrincipal = ''
let idSessao = ''
let nomeSessao = ''
let arquivoSessao = '' // transcript da sessão (vem em todo evento clássico): é onde o app grava o título da conversa
let tituloLidoEm = 0
let tituloDoApp = ''

const corta = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const base = (p: unknown) => String(p ?? '').split(/[\\/]/).pop() ?? ''

// ---------- arquivos e processos (só aqui o $ pode ir) ----------

let pasta = ''

/** Pasta dos registros: `<LOCALAPPDATA>/painel-vivo/runs`, com barras normais (o Git Bash entende). */
async function pastaRuns($: any): Promise<string> {
  if (pasta) return pasta
  const raiz = (await $.env.get('LOCALAPPDATA')) ?? (await $.env.get('TEMP')) ?? 'C:/Temp'
  pasta = `${String(raiz).replace(/\\/g, '/')}/painel-vivo/runs`
  return pasta
}

/** Registros com mais de 1 dia saem: guardam saída de comando (pode haver dado de caso) e o $.fs não apaga. */
async function limparAntigos($: any): Promise<void> {
  const dir = (await pastaRuns($)).replace(/'/g, "''")
  const ps = `if (Test-Path '${dir}') { Get-ChildItem -LiteralPath '${dir}' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue }`
  await $.process.run(['powershell', '-NoProfile', '-Command', ps], { timeoutMs: 20000 }).catch(() => undefined)
}

/** O hook do rtk só enxergaria o envoltório; então pede a reescrita antes de envolver. */
async function comRtk($: any, cmd: string): Promise<string> {
  const r = await $.process.run(['rtk', 'rewrite', cmd], { timeoutMs: 5000 }).catch(() => undefined)
  const out = String(r?.stdout ?? '').trim()
  return r?.exitCode === 0 && out.startsWith('rtk') ? out : cmd
}

const caudas = new Map<string, number>() // registro → mtime da última leitura

/** Cauda e % do registro; undefined se não mudou desde a última leitura. Acima de 3 MB, só o sinal de vida. */
async function lerCauda($: any, log: string): Promise<{ cauda?: string[]; pct?: number; mtime: number } | undefined> {
  const st = await $.fs.stat(log).catch(() => undefined)
  if (!st || st.kind !== 'file' || caudas.get(log) === st.mtimeMs) return undefined
  caudas.set(log, st.mtimeMs)
  if (st.size > LIMITE) return { mtime: st.mtimeMs }
  return { ...caudaDe(String(await $.fs.read(log).catch(() => ''))), mtime: st.mtimeMs }
}

const agys = new Map<string, PassosAgy & { mtime: number }>() // arquivo de eventos → leitura (relê só se mudou)

/** Passos do agy na pasta do comando: um arquivo por chamada; passos somados, o resto do arquivo mais novo. */
async function lerAgy($: any, dir: string): Promise<(PassosAgy & { mtime: number }) | undefined> {
  const itens = await $.fs.list(dir).catch(() => undefined)
  if (!Array.isArray(itens)) return undefined
  const arqs = itens.filter((it: any) => it.kind === 'file' && String(it.name).endsWith('.jsonl') && it.size <= LIMITE)
    .sort((a: any, b: any) => a.mtimeMs - b.mtimeMs)
  let passos = 0
  let ultimo: (PassosAgy & { mtime: number }) | undefined
  for (const it of arqs) {
    const arq = `${dir}/${it.name}`
    let l = agys.get(arq)
    if (!l || l.mtime !== it.mtimeMs) {
      l = { ...lerEventosAgy(String(await $.fs.read(arq).catch(() => ''))), mtime: it.mtimeMs }
      agys.set(arq, l)
    }
    passos += l.passos
    ultimo = l
  }
  return ultimo && { ...ultimo, passos }
}

async function lerJornal($: any, dir: string): Promise<Record<string, string>> {
  return fasesDoJornal(String(await $.fs.read(`${dir}/journal.jsonl`).catch(() => '')))
}

function trab(id: string, tipo: Trabalhador['tipo'], pai: string, inicio: number, extra: Partial<Trabalhador>): Trabalhador {
  return { id, tipo, pai, rotulo: '', agora: 'começando', inicio, situacao: 'rodando', ultimoSinal: inicio, acoes: [], ...extra }
}

/** Dono de uma chamada: 'principal', o subagente (id da chamada Agent) ou o agente de workflow (`ag:<id>`). */
function donoEm(ts: Ts, agentId?: string): string | undefined {
  if (!agentId) return 'principal'
  const d = donos.get(agentId)
  if (d && ts[d]) return d
  if (ts[`ag:${agentId}`]) return `ag:${agentId}`
  return Object.values(ts).find(t => t.agentId === agentId)?.id
}

// Agente que chega sem agent.spawn (recarga no meio): fica sob o workflow que roda, senão sob o principal.
function solto(ts: Ts, agentId: string, inicio: number): Trabalhador {
  const wf = Object.values(ts).filter(t => t.tipo === 'workflow' && t.situacao === 'rodando').pop()
  return trab(`ag:${agentId}`, 'agente-wf', wf?.id ?? 'principal', inicio, { rotulo: 'agente', agentId })
}

const comAcao = (t: Trabalhador, a: Acao): Trabalhador =>
  ({ ...t, acoes: [...t.acoes, a].slice(-60), agora: a.texto, ultimoSinal: Math.max(t.ultimoSinal, a.t) })
const marcaErro = (acoes: Acao[], a: Acao) => acoes.map(x => (x.t === a.t && x.texto === a.texto ? { ...x, erro: true } : x))

/** Fecha os descendentes que ainda rodam (agente que terminou, workflow que acabou). */
function fecharFilhos(ts: Ts, raiz: string, fim: number, situacao: Situacao): Ts {
  const out = { ...ts }
  const fila = [raiz]
  const visto = new Set([raiz])
  while (fila.length) {
    const p = fila.pop()!
    for (const t of Object.values(out)) {
      if (t.pai !== p || visto.has(t.id)) continue
      visto.add(t.id)
      fila.push(t.id)
      if (t.situacao === 'rodando') out[t.id] = { ...t, situacao, fim }
    }
  }
  return out
}

/** Acima de MAX_TRAB, tira os concluídos mais antigos (nunca quem roda nem os pais de quem roda). */
function poda(ts: Ts): Ts {
  const lista = Object.values(ts)
  if (lista.length <= MAX_TRAB) return ts
  const fica = new Set(lista.filter(t => t.situacao === 'rodando').map(t => t.id))
  for (const id of [...fica]) for (let p = ts[id]?.pai; p && ts[p] && !fica.has(p); p = ts[p]!.pai) fica.add(p)
  const fora = lista.filter(t => !fica.has(t.id)).sort((a, b) => (a.fim ?? a.inicio) - (b.fim ?? b.inicio))
  const out = { ...ts }
  for (const t of fora.slice(0, lista.length - MAX_TRAB)) delete out[t.id]
  return out
}

function tipoDe(ferramenta: string, e: any): Trabalhador['tipo'] | undefined {
  if (ferramenta === 'Agent' || ferramenta === 'Task') return 'subagente'
  if (ferramenta === 'Workflow') return 'workflow'
  if (ferramenta === 'AskUserQuestion') return 'pergunta'
  if (!COMANDOS.has(ferramenta)) return undefined
  const cmd = String(e.command ?? '')
  return RE_CODEX.test(cmd) ? 'codex' : RE_AGY.test(cmd) ? 'agy' : 'comando'
}

const campo = (s: string, k: string) =>
  new RegExp(`\\b${k}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`).exec(s)?.[2]?.replace(/\\(.)/g, '$1')

/** `export const meta = { name, description, phases: [{ title, detail }] }` do script do Workflow. */
export function lerMeta(script: string): { nome: string; desc: string; fases: Workflow['fases'] } {
  const i = script.search(/\bmeta\s*=/)
  const bloco = i < 0 ? '' : script.slice(i, i + 8000)
  const fasesTxt = /\bphases\s*:\s*\[([\s\S]*?)\]/.exec(bloco)?.[1] ?? ''
  const fases = [...fasesTxt.matchAll(/\{([^{}]*)\}/g)]
    .map(m => ({ titulo: campo(m[1]!, 'title') ?? '', ...(campo(m[1]!, 'detail') ? { detalhe: campo(m[1]!, 'detail') } : {}) }))
    .filter(f => f.titulo)
  const resto = fasesTxt ? bloco.replace(fasesTxt, '') : bloco
  return { nome: campo(resto, 'name') ?? '', desc: campo(resto, 'description') ?? '', fases }
}

function rotuloDe(tipo: Trabalhador['tipo'], e: any): Partial<Trabalhador> {
  if (tipo === 'subagente') return { rotulo: String(e.subagent_type ?? 'general-purpose'), tarefa: corta(e.description || e.prompt, 300) }
  if (tipo === 'workflow') {
    const m = lerMeta(String(e.script ?? ''))
    return { rotulo: m.nome || String(e.name ?? 'Workflow'), ...(m.desc ? { tarefa: corta(m.desc, 300) } : {}) }
  }
  if (tipo === 'pergunta') {
    const q = e.questions?.[0]
    return { rotulo: corta(q?.header || 'Pergunta', 40), tarefa: corta(q?.question, 300), agora: 'aguardando resposta' }
  }
  return { rotulo: corta(e.description || e.command, 80), tarefa: corta(e.command, 300), agora: 'rodando' }
}

function pendenteDe(ferramenta: string, e: any, id: string, quem: string, desde: number): Pendente | undefined {
  if (ferramenta === 'AskUserQuestion') {
    const q = e.questions?.[0]
    const opcoes = (q?.options ?? []).map((o: any) => o?.label).filter(Boolean).join(' · ')
    return { id, tipo: 'pergunta', titulo: `Pergunta: ${corta(q?.question || q?.header || 'aguardando resposta', 90)}`, ...(opcoes ? { detalhe: opcoes } : {}), quem, desde }
  }
  if (ferramenta === 'ExitPlanMode') return { id, tipo: 'plano', titulo: 'Plano aguardando aprovação', quem, desde }
  return undefined
}

async function tirarPendentes($: any, ids: string[]): Promise<void> {
  const ps: Record<string, Pendente> = await read($, pendentes)
  if (!ids.some(i => ps[i])) return
  await update($, pendentes, p => {
    const out = { ...p }
    for (const i of ids) delete out[i]
    return out
  })
}

// ---------- tool.call ----------

type Chamada = { id: string; ferramenta: string; e: any; dono: string; acao: Acao; inicio: number; rascunho?: Trabalhador; criado: boolean }

/**
 * Toda chamada de ferramenta: vira ação do dono (principal ou agente) e, se importante, trabalhador filho dele.
 * Bash/PowerShell ganham AGY_EVENTS_DIR (fundo inclusive): o agy chamado por qualquer script grava os passos.
 */
async function aoChamar($: any, e: any, next: any) {
  const ferramenta = String(e.tool)
  const agentId: string | undefined = e.agentId
  fazendo.delete(agentId ?? '')
  if (INTERNAS.has(ferramenta)) return next(e)
  if (PLANO.has(ferramenta)) {
    const r = await next(e)
    await anotarPlano($, e, r).catch(() => undefined)
    return r
  }
  const id = String(e.tool_use_id)
  const inicio: number = await $.clock.now()
  const dono = agentId ? donoEm(await read($, trabalhadores), agentId) ?? `ag:${agentId}` : 'principal'
  const acao: Acao = { t: inicio, ...acaoDe(ferramenta, e) }
  const tipo = tipoDe(ferramenta, e)
  const fundo = e.run_in_background === true
  let entrada = e
  let rascunho: Trabalhador | undefined
  if (tipo) {
    const extra: Partial<Trabalhador> = { ...rotuloDe(tipo, e), ...(fundo ? { emFundo: true } : {}) }
    // Codex não informa modelo nem tokens na saída; o modelo só se o comando o escolher (--model / -m).
    const mCodex = tipo === 'codex' ? /(?:--model|\s-m)[\s=]+["']?([\w.:-]+)/.exec(String(e.command ?? ''))?.[1] : undefined
    if (mCodex) extra.modelo = mCodex
    if (COMANDOS.has(ferramenta) && String(e.command ?? '').trim()) {
      const dir = await pastaRuns($)
      const agyDir = `${dir}/${id}.agy`
      extra.agyDir = agyDir
      if (ferramenta === 'PowerShell') entrada = { ...e, command: envolverPowerShell(e.command, agyDir) }
      else if (fundo) entrada = { ...e, command: envolverBash(e.command, agyDir) } // a saída vai ao arquivo do motor
      else {
        extra.log = `${dir}/${id}.log`
        entrada = { ...e, command: envolverBash(await comRtk($, e.command), agyDir, extra.log) }
      }
    }
    rascunho = trab(id, tipo, dono, inicio, extra)
  }
  // Comando de agente em primeiro plano fica só como ação dele; o relógio o promove se passar de 5 s.
  const criado = !!rascunho && !(agentId && tipo === 'comando' && !fundo)
  emVoo.set(id, { id, tool: ferramenta, agentId, dono, inicio, rascunho, criado })

  if (agentId || criado) {
    await update($, trabalhadores, atual => {
      const out = { ...atual }
      if (agentId) out[dono] = comAcao(out[dono] ?? solto(atual, agentId, inicio), acao)
      if (criado) out[id] = rascunho!
      return poda(out)
    })
  }
  if (!agentId) await update($, principal, p => ({ ...p, ultimoSinal: inicio, acoes: [...p.acoes, acao].slice(-200) }))
  const pend = pendenteDe(ferramenta, e, id, criado ? id : dono, inicio)
  if (pend) await update($, pendentes, ps => ({ ...ps, [id]: pend }))

  let r: any
  try {
    r = await next(entrada)
  } finally {
    const v = emVoo.get(id)
    emVoo.delete(id)
    await fechar($, { id, ferramenta, e, dono, acao, inicio, rascunho, criado: v?.criado ?? criado }, r).catch(() => undefined)
  }
  return r
}

async function fechar($: any, c: Chamada, r: any): Promise<void> {
  const fim: number = await $.clock.now()
  const res: any = (r && !r.isError && r.deny === undefined ? r.result : undefined) ?? {}
  const texto = String(r?.text ?? '')
  let erro = !r || r.deny !== undefined || r.isError === true
  let fundo = false
  const muda: Partial<Trabalhador> = {}
  if (COMANDOS.has(c.ferramenta) && res.backgroundTaskId) {
    // Em segundo plano (pedido, ctrl+b ou estouro de tempo): fica rodando até o aviso de término.
    fundo = true
    muda.emFundo = true
    muda.tarefaFundo = String(res.backgroundTaskId)
    const saida = c.rascunho?.log ? undefined : arquivoDeSaida(texto)
    if (saida) muda.log = saida
  }
  if (c.ferramenta === 'Agent' || c.ferramenta === 'Task') {
    if (res.agentId) muda.agentId = String(res.agentId)
    if (res.resolvedModel) muda.modelo = String(res.resolvedModel)
    if (res.status === 'async_launched') {
      fundo = true
      muda.emFundo = true
      muda.tarefaFundo = String(res.agentId ?? '')
    }
  }
  if (c.ferramenta === 'Workflow') {
    erro = erro || !!res.error
    const tarefa = res.taskId ?? /Task ID: ([\w-]+)/.exec(texto)?.[1] ?? /running in background with ID: ([\w-]+)/.exec(texto)?.[1]
    if (!erro && tarefa) {
      fundo = true
      muda.emFundo = true
      muda.tarefaFundo = String(tarefa)
    }
    const w = await workflowDe($, c, res, texto)
    muda.rotulo = w.nome
    if (w.desc) muda.tarefa = corta(w.desc, 300)
    await update($, workflows, ws => ({ ...ws, [c.id]: { ...w, fasePorAgente: ws[c.id]?.fasePorAgente ?? {} } }))
  }
  const promover = !c.criado && !!c.rascunho && (fim - c.inicio >= MESA || fundo)
  if (c.criado || promover || (erro && c.dono !== 'principal')) {
    await update($, trabalhadores, atual => {
      const out = { ...atual }
      if (promover && !out[c.id]) out[c.id] = c.rascunho!
      const t = out[c.id]
      if (t && (c.criado || promover)) {
        const fecha = !fundo && t.situacao === 'rodando'
        out[c.id] = { ...t, ...muda, ...(fecha ? { situacao: erro ? 'falhou' : 'feito', fim, acoes: t.acoes.slice(-20) } : {}) }
      }
      const d = out[c.dono]
      if (erro && d) out[c.dono] = { ...d, acoes: marcaErro(d.acoes, c.acao) }
      return out
    })
  }
  if (erro && c.dono === 'principal') await update($, principal, p => ({ ...p, acoes: marcaErro(p.acoes, c.acao) }))
  await tirarPendentes($, [c.id, `perm:${c.e.agentId ?? 'principal'}:${c.ferramenta}`])
}

async function workflowDe($: any, c: Chamada, res: any, texto: string): Promise<Workflow> {
  let script = String(c.e.script ?? '')
  const caminho = res.scriptPath ?? c.e.scriptPath
  if (!script && caminho) script = String(await $.fs.read(String(caminho)).catch(() => ''))
  const meta = lerMeta(script)
  const dir = res.transcriptDir ?? /Transcript dir: ([^\n]+)/.exec(texto)?.[1]?.trim()
  return {
    id: c.id,
    nome: res.workflowName || meta.nome || String(c.e.name ?? 'Workflow'),
    desc: meta.desc,
    fases: meta.fases,
    fasePorAgente: {},
    ...(dir ? { dir: String(dir).replace(/\\/g, '/') } : {}),
    ...(res.runId ? { runId: String(res.runId) } : {}),
  }
}

/** Checklist declarado (TodoWrite, TaskCreate/TaskUpdate) vira o plano do agente que o declarou. */
async function anotarPlano($: any, e: any, r: any): Promise<void> {
  const chave = e.agentId ?? ''
  let plano: Plano
  if (e.tool === 'TodoWrite') {
    const todos: any[] = Array.isArray(e.todos) ? e.todos : []
    const atual = todos.find(t => t?.status === 'in_progress')?.activeForm
    plano = { feitos: todos.filter(t => t?.status === 'completed').length, total: todos.length, ...(atual ? { atual } : {}) }
  } else {
    const lista = tarefas.get(chave) ?? new Map<string, { status: string; atual?: string }>()
    tarefas.set(chave, lista)
    const tid = String(e.tool === 'TaskCreate' ? r?.result?.task?.id ?? '' : e.taskId ?? '')
    if (!tid) return
    const x = lista.get(tid)
    if (e.status === 'deleted') lista.delete(tid)
    else lista.set(tid, { status: e.status ?? x?.status ?? 'pending', atual: e.activeForm ?? e.subject ?? x?.atual })
    const vs = [...lista.values()]
    const atual = vs.find(v => v.status === 'in_progress')?.atual
    plano = { feitos: vs.filter(v => v.status === 'completed').length, total: vs.length, ...(atual ? { atual } : {}) }
  }
  if (!chave) await update($, principal, p => ({ ...p, plano }))
  else {
    await update($, trabalhadores, ts => {
      const d = donoEm(ts, chave)
      return d && ts[d] ? { ...ts, [d]: { ...ts[d]!, plano } } : ts
    })
  }
}

// ---------- agentes e turnos ----------

/**
 * agent.spawn dispara para o subagente da chamada Agent e para cada agent() de Workflow (e.workflow presente,
 * e.tool_use_id = a chamada Workflow). Agente de workflow vira `ag:<agentId>` sob o workflow.
 */
async function aoNascerAgente($: any, e: any, next: any) {
  const r = await next(e)
  const agentId: string | undefined = r?.agentId
  if (!agentId) return r
  const inicio: number = await $.clock.now()
  const ws: Record<string, Workflow> = e.workflow ? await read($, workflows) : {}
  await update($, trabalhadores, ts => {
    const out = { ...ts }
    if (e.workflow) {
      const porRun = Object.values(ws).find(w => w.runId && w.runId === e.workflow.runId)?.id
      const pai = e.tool_use_id || porRun || donoEm(ts, e.parentAgentId) || 'principal'
      const id = `ag:${agentId}`
      const fase = ws[pai]?.fasePorAgente[agentId]
      out[id] = {
        ...trab(id, 'agente-wf', pai, inicio, { agentId, modelo: r.model, ...(fase ? { fase } : {}) }),
        ...(out[id] ?? {}), // chegou antes uma ferramenta dele (solto): mantém ações e sinais
        pai,
        rotulo: String(e.description || e.name || 'agente'),
        tarefa: corta(e.prompt, 300),
      }
      donos.set(agentId, id)
    } else {
      const id = e.tool_use_id && ts[e.tool_use_id] ? e.tool_use_id : `ag:${agentId}`
      const t = out[id] ?? trab(id, 'subagente', donoEm(ts, e.parentAgentId) ?? 'principal', inicio, { tarefa: corta(e.description || e.prompt, 300) })
      out[id] = { ...t, agentId, modelo: r.model, rotulo: String(e.subagentType || t.rotulo || 'general-purpose'), ...(e.background ? { emFundo: true } : {}) }
      donos.set(agentId, id)
    }
    return poda(out)
  })
  return r
}

async function aoComecarTurno($: any, e: any): Promise<void> {
  turnoPrincipal = String(e.turnId ?? '')
  const agora: number = await $.clock.now()
  await update($, principal, p => ({ ...p, ocupado: true, ultimoSinal: agora }))
}

const novosDe = (u: any) => (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0)

/** Fim de turno: principal fica ocioso; agente fecha (e os filhos que ainda rodam), com tokens conferidos. */
async function aoTerminarTurno($: any, e: any): Promise<void> {
  const agora: number = await $.clock.now()
  if (!e.agentId) {
    await update($, principal, p => ({ ...p, ocupado: false, fimTurno: agora }))
    if (e.reason === 'answer') {
      const ps: Record<string, Pendente> = await read($, pendentes)
      await tirarPendentes($, Object.values(ps).filter(p => p.tipo === 'falha-api').map(p => p.id))
    }
    return
  }
  const g = gasto.get(e.agentId)
  gasto.delete(e.agentId)
  fazendo.delete(e.agentId)
  const situacao: Situacao = e.reason === 'answer' ? 'feito' : e.reason === 'aborted' ? 'parado' : 'falhou'
  await update($, trabalhadores, ts => {
    const id = donoEm(ts, e.agentId)
    const t = id ? ts[id] : undefined
    if (!t) return ts
    let novos = (t.tokensNovos ?? 0) + (g?.novos ?? 0)
    let cache = (t.tokensCache ?? 0) + (g?.cache ?? 0)
    if (e.usage) {
      novos = Math.max(novos, novosDe(e.usage))
      cache = Math.max(cache, e.usage.cache_read_input_tokens ?? 0)
    }
    const fecha = t.situacao === 'rodando'
    const out = { ...ts, [t.id]: { ...t, tokensNovos: novos, tokensCache: cache, ...(fecha ? { situacao, fim: agora, acoes: t.acoes.slice(-20) } : {}) } }
    return fecha ? fecharFilhos(out, t.id, agora, 'feito') : out
  })
  if (e.reason === 'answer') await tirarPendentes($, [`api:${e.agentId}`])
}

// turn.step: cada trecho só anota na memória do módulo; o relógio grava no máximo a cada 2 s.
function comecarPedido(agentId?: string, modelo?: string): void {
  emPedido.add(agentId ?? '')
  if (agentId && modelo) modelos.set(agentId, modelo)
}

function trecho(agentId: string | undefined, c: any): void {
  const k = agentId ?? ''
  if (c.kind === 'text') fazendo.set(k, 'escrevendo a resposta')
  else if (c.kind === 'thinking' || c.kind === 'tool') fazendo.set(k, 'pensando')
  else if (c.kind === 'stop' && c.usage) {
    const g = gasto.get(k) ?? { novos: 0, cache: 0 }
    g.novos += novosDe(c.usage)
    g.cache += c.usage.cache_read_input_tokens ?? 0
    gasto.set(k, g)
  }
}

function fimPedido(agentId?: string): void {
  emPedido.delete(agentId ?? '')
}

// ---------- fim de tarefa em segundo plano ----------

const tag = (s: string, n: string) => new RegExp(`<${n}>([^<]+)</${n}>`).exec(s)?.[1]?.trim()

function situacaoDe(status = '', codigo?: string): Situacao {
  if (/killed|stopped/.test(status)) return 'parado'
  if (/fail|error/.test(status) || (codigo !== undefined && codigo !== '0')) return 'falhou'
  return 'feito'
}

/** Aviso de término (prompt.submit com origin.kind 'task-notification'; reserva: o XML no texto). */
async function aoReceberPrompt($: any, e: any): Promise<void> {
  const texto = String(e.text ?? '')
  if (e.origin?.kind !== 'task-notification' && !texto.includes('<task-notification>')) return
  const avisos = [...texto.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].map(m => m[1] ?? '')
  if (!avisos.length) return
  const fim: number = await $.clock.now()
  const fechar = avisos.map(corpo => ({
    ids: [tag(corpo, 'tool-use-id'), tag(corpo, 'task-id')].filter((x): x is string => !!x),
    situacao: situacaoDe(tag(corpo, 'status'), /exit code (\d+)/.exec(corpo)?.[1]),
  }))
  await update($, trabalhadores, ts => {
    let out = { ...ts }
    for (const f of fechar) {
      const t = Object.values(out).find(x => f.ids.includes(x.id) || (!!x.tarefaFundo && f.ids.includes(x.tarefaFundo)))
      if (!t || t.situacao !== 'rodando') continue
      out[t.id] = { ...t, situacao: f.situacao, fim }
      out = fecharFilhos(out, t.id, fim, f.situacao === 'feito' ? 'feito' : 'parado')
    }
    return out
  })
}

/** classic.Stop: lista vazia de tarefas em segundo plano prova que nada mais roda sozinho (aviso perdido). */
async function aoParar($: any, e: any): Promise<void> {
  if (!Array.isArray(e.background_tasks) || e.background_tasks.length) return
  const ts: Ts = await read($, trabalhadores)
  if (!Object.values(ts).some(t => t.emFundo && t.situacao === 'rodando')) return
  const fim: number = await $.clock.now()
  await update($, trabalhadores, atual => {
    let out = { ...atual }
    for (const t of Object.values(atual)) {
      if (!t.emFundo || out[t.id]?.situacao !== 'rodando') continue
      out[t.id] = { ...t, situacao: 'feito', fim }
      out = fecharFilhos(out, t.id, fim, 'feito')
    }
    return out
  })
}

// ---------- pendências: permissão, falha de API ----------

function tituloPermissao(tool: string, inp: any, cmd?: string): string {
  const desc = corta(inp?.description, 80)
  if (COMANDOS.has(tool)) return `Permissão para rodar: ${desc ? desc[0]!.toLowerCase() + desc.slice(1) : corta(cmd ?? inp?.command, 60)}`
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return `Permissão para editar ${base(inp?.file_path ?? inp?.notebook_path) || 'um arquivo'}`
  if (tool === 'WebFetch') {
    let host = corta(inp?.url, 40)
    try { host = new URL(String(inp?.url)).hostname } catch {}
    return `Permissão para acessar ${host}`
  }
  return `Permissão para usar ${tool.startsWith('mcp__') ? tool.split('__').pop() : tool}`
}

/**
 * classic.PermissionRequest não traz tool_use_id: a chamada é a mais recente em andamento da mesma ferramenta
 * no mesmo agente. Sem ela, `perm:<agente>:<ferramenta>`. Devolve o id da pendência. Só observa.
 */
async function anotarPermissao($: any, e: any): Promise<string> {
  const agentId: string | undefined = e.agent_id
  const v = [...emVoo.values()].filter(x => x.tool === e.tool_name && (x.agentId ?? '') === (agentId ?? '')).pop()
  const id = v?.id ?? `perm:${agentId ?? 'principal'}:${e.tool_name}`
  const quem = v ? (v.criado ? v.id : v.dono) : agentId ? donoEm(await read($, trabalhadores), agentId) ?? 'principal' : 'principal'
  const cmd = v?.rascunho?.tarefa
  const detalhe = corta(cmd ?? e.tool_input?.file_path ?? e.tool_input?.url ?? '', 200)
  const desde: number = await $.clock.now()
  const p: Pendente = { id, tipo: 'permissao', titulo: tituloPermissao(String(e.tool_name), e.tool_input, cmd), ...(detalhe ? { detalhe } : {}), quem, desde }
  await update($, pendentes, ps => ({ ...ps, [id]: p }))
  return id
}

async function negarPermissao($: any, e: any): Promise<void> {
  await tirarPendentes($, [String(e.tool_use_id), `perm:${e.agent_id ?? 'principal'}:${e.tool_name}`])
}

const FALHAS: Record<string, string> = {
  rate_limit: 'Limite de uso atingido',
  overloaded: 'Serviço sobrecarregado',
  billing_error: 'Problema de cobrança na conta',
  authentication_failed: 'Falha de autenticação',
  server_error: 'Erro no servidor da API',
  max_output_tokens: 'Resposta cortada no limite de tamanho',
}

/** classic.StopFailure: some no próximo turno bem-sucedido (ou ao dispensar). */
async function anotarFalhaApi($: any, e: any): Promise<void> {
  const agentId: string | undefined = e.agent_id
  const id = `api:${agentId ?? 'principal'}`
  const quem = agentId ? donoEm(await read($, trabalhadores), agentId) ?? 'principal' : 'principal'
  const desde: number = await $.clock.now()
  const detalhe = corta(e.error_details, 200)
  const p: Pendente = { id, tipo: 'falha-api', titulo: FALHAS[String(e.error)] ?? `Falha da API (${e.error})`, ...(detalhe ? { detalhe } : {}), quem, desde }
  await update($, pendentes, ps => ({ ...ps, [id]: p }))
}

// ---------- uso, título, sessão ----------

async function anotarUso($: any, ctx: any, rl: any[]): Promise<void> {
  const k = (n: string) => (rl ?? []).find(r => r?.kind === n)
  const novo: Uso = JSON.parse(JSON.stringify({
    contextoPct: ctx?.percent,
    cota5h: k('five_hour')?.percentUsed,
    renova5h: k('five_hour')?.resetsAt,
    semana: k('seven_day')?.percentUsed,
    renovaSemana: k('seven_day')?.resetsAt,
  }))
  const antes: Uso = await read($, uso)
  const junto = { ...antes, ...novo } // cota que não veio nesta leitura fica a anterior
  if (JSON.stringify(junto) !== JSON.stringify(antes)) await update($, uso, () => junto)
}

// O app grava o nome da conversa no transcript ({"type":"custom-title","customTitle":"…"}); session_title não chega.
// O transcript passa de 4 MiB (limite do $.fs.read), então um Python curto devolve só o título, em JSON ASCII.
const PY_TITULO = `import sys,json
t=""
for l in open(sys.argv[1],encoding="utf-8",errors="ignore"):
  if '"custom-title"' in l:
    try: t=json.loads(l).get("customTitle") or t
    except Exception: pass
print(json.dumps(t))`

/** Lê o título da conversa a cada 30 s até achar; depois a cada 5 min (pega renomeação). */
async function lerTituloDoApp($: any, agora: number): Promise<void> {
  if (!arquivoSessao || agora - tituloLidoEm < (tituloDoApp ? 300_000 : 30_000)) return
  tituloLidoEm = agora
  const r = await $.process.run(['python', '-I', '-c', PY_TITULO, arquivoSessao], { timeoutMs: 15000 }).catch(() => undefined)
  let t = ''
  try { t = String(JSON.parse(String(r?.stdout ?? '').trim() || '""') ?? '') } catch {}
  if (!t) return
  tituloDoApp = t
  await anotarTitulo($, t)
}

/** Guarda o caminho do transcript que todo evento clássico traz. */
function anotarArquivo(e: any): void {
  if (e?.transcript_path) arquivoSessao = String(e.transcript_path)
}

/** Título da sessão (o mesmo da lista do app): do transcript, ou de session_title se um dia vier. */
async function anotarTitulo($: any, titulo: unknown): Promise<void> {
  const t = corta(titulo, 80)
  if (!t) return
  nomeSessao = t
  const p: Principal = await read($, principal)
  if (p.titulo !== t) await update($, principal, x => ({ ...x, titulo: t }))
}

async function iniciar($: any): Promise<void> {
  idSessao = await $.session.id()
  const salvo = await $.store.get('glossario')
  if (Array.isArray(salvo)) await update($, glossario, () => salvo)
  const u = await $.session.usage().catch(() => undefined)
  if (u) await anotarUso($, u.context, u.rateLimits)
  // Nome de reserva até o app dar o título: pasta e hora de início (distingue sessões na mesma pasta).
  if (!nomeSessao) nomeSessao = `${base(await $.session.cwd())} · ${horaCurta(u?.startedAt ?? (await $.clock.now()))}`
  void limparAntigos($)
}

/** Ao encerrar: some da lista das outras sessões na hora. */
async function encerrar($: any, id?: string): Promise<void> {
  const qual = id || idSessao
  if (qual) await $.store.delete(chaveSessao(qual)).catch(() => undefined)
}

async function textoGlossario($: any): Promise<string> {
  const g: { termo: string; definicao: string }[] = await read($, glossario)
  return g.length ? g.map(t => `- **${t.termo}**: ${t.definicao}`).join('\n') : 'O glossário está vazio. Use Explicar no painel para começar.'
}

// ---------- relógio ----------

let girando = false
let ultimoUso = 0
let ultimaSessao = 0
let publicouOcioso = false

const difere = (t: Trabalhador, m: Partial<Trabalhador>) =>
  Object.entries(m).some(([k, v]) => (k === 'ultimoSinal' ? (v as number) > t.ultimoSinal : JSON.stringify((t as any)[k]) !== JSON.stringify(v)))

/** A cada 2 s: só age se há algo rodando ou pendente. Ocioso: só lê as outras sessões, a cada 10 s. */
async function tique($: any): Promise<void> {
  if (girando) return
  girando = true
  try {
    await girar($)
  } catch {
    // um tique perdido não derruba o relógio
  } finally {
    girando = false
  }
}

async function girar($: any): Promise<void> {
  const agora: number = await $.clock.now()
  await lerTituloDoApp($, agora).catch(nada)
  const [ts, pri, pend] = (await Promise.all([read($, trabalhadores), read($, principal), read($, pendentes)])) as [Ts, Principal, Record<string, Pendente>]
  const ativo = pri.ocupado || emVoo.size > 0 || Object.keys(pend).length > 0 || Object.values(ts).some(t => t.situacao === 'rodando')
  if (!ativo) {
    if (agora - ultimaSessao >= 10_000) {
      ultimaSessao = agora
      await trocarSessoes($, agora, !publicouOcioso) // publica "ocioso" uma vez; depois as outras deixam de nos ver
      publicouOcioso = true
    }
    return
  }
  publicouOcioso = false
  const muda: Record<string, Partial<Trabalhador>> = {}
  const mexe = (id: string | undefined, m: Partial<Trabalhador>) => {
    if (id && id !== 'principal') muda[id] = { ...muda[id], ...m }
  }

  // 1. comando de agente em voo vira trabalhador aos 5 s, ou já, se o agy começou a gravar passos
  const novos: Trabalhador[] = []
  for (const v of emVoo.values()) {
    if (v.criado || !v.rascunho) continue
    if (agora - v.inicio >= MESA || (v.rascunho.agyDir && (await $.fs.exists(v.rascunho.agyDir).catch(() => false)))) {
      v.criado = true
      novos.push(v.rascunho)
    }
  }
  const vivo: Ts = { ...ts }
  for (const n of novos) vivo[n.id] = vivo[n.id] ?? n

  // 2. sinais do modelo: pedido em curso conta como vida; o que faz; modelo; tokens
  for (const ag of emPedido) if (ag) mexe(donoEm(vivo, ag), { ultimoSinal: agora })
  for (const [ag, txt] of fazendo) {
    const id = donoEm(vivo, ag)
    if (ag && id && vivo[id]?.situacao === 'rodando') mexe(id, { agora: txt })
  }
  for (const [ag, mod] of modelos) {
    const id = donoEm(vivo, ag)
    if (id && vivo[id] && !vivo[id]!.modelo) mexe(id, { modelo: mod })
  }
  modelos.clear()
  const tok = new Map(gasto)
  gasto.clear()

  // 3. saída dos comandos (cauda, %) e passos do agy, só de quem roda
  for (const t of Object.values(vivo)) {
    if (t.situacao !== 'rodando') continue
    if (t.log) {
      const c = await lerCauda($, t.log)
      if (c) {
        mexe(t.id, { ...(c.cauda ? { cauda: c.cauda } : {}), ...(c.pct !== undefined ? { pct: c.pct } : {}), ultimoSinal: c.mtime })
        const linha = t.tipo === 'codex' ? c.cauda?.filter(l => l.startsWith('[codex]')).pop() : undefined
        if (linha) mexe(t.id, { agora: corta(linha.replace('[codex]', ''), 80) })
      }
    }
    if (t.agyDir) {
      const g = await lerAgy($, t.agyDir)
      if (g) mexe(t.id, { tipo: 'agy', passos: g.passos, agora: traduzirPassoAgy(g.agora), ...(g.modelo ? { modelo: g.modelo } : {}), ...(g.tokens ? { tokensNovos: g.tokens } : {}), ultimoSinal: g.mtime })
    }
  }

  // 4. fase de cada agente de workflow (journal), só enquanto o workflow roda
  const wfs: Record<string, Workflow> = await read($, workflows)
  const fasesNovas: Record<string, Record<string, string>> = {}
  for (const t of Object.values(vivo)) {
    const w = t.tipo === 'workflow' && t.situacao === 'rodando' ? wfs[t.id] : undefined
    if (!w?.dir) continue
    const fases = await lerJornal($, w.dir)
    if (JSON.stringify(fases) !== JSON.stringify(w.fasePorAgente)) fasesNovas[t.id] = fases
    for (const [ag, f] of Object.entries(fases)) if (vivo[`ag:${ag}`]) mexe(`ag:${ag}`, { fase: f })
  }
  if (Object.keys(fasesNovas).length) {
    await update($, workflows, ws => {
      const out = { ...ws }
      for (const [id, f] of Object.entries(fasesNovas)) if (out[id]) out[id] = { ...out[id]!, fasePorAgente: f }
      return out
    })
  }

  // 5. grava tudo de uma vez, só se algo mudou
  const agentesTok = [...tok.keys()].filter(Boolean)
  if (novos.length || agentesTok.length || Object.entries(muda).some(([id, m]) => vivo[id] && difere(vivo[id]!, m))) {
    await update($, trabalhadores, atual => {
      const out = { ...atual }
      for (const n of novos) out[n.id] = out[n.id] ?? n
      for (const [id, m] of Object.entries(muda)) {
        const t = out[id]
        if (t) out[id] = { ...t, ...m, ultimoSinal: Math.max(t.ultimoSinal, m.ultimoSinal ?? 0) }
      }
      for (const ag of agentesTok) {
        const id = donoEm(out, ag)
        const t = id ? out[id] : undefined
        const g = tok.get(ag)!
        if (t) out[t.id] = { ...t, tokensNovos: (t.tokensNovos ?? 0) + g.novos, tokensCache: (t.tokensCache ?? 0) + g.cache }
      }
      return poda(out)
    })
  }
  const gp = tok.get('')
  if (emPedido.has('') || gp) {
    await update($, principal, p => ({
      ...p,
      ...(emPedido.has('') ? { ultimoSinal: agora } : {}),
      ...(gp ? { tokensNovos: p.tokensNovos + gp.novos, tokensCache: p.tokensCache + gp.cache } : {}),
    }))
  }

  // 6. uso (a cada 10 s) e outras sessões (a cada 5 s)
  if (agora - ultimoUso >= 10_000) {
    ultimoUso = agora
    const u = await $.session.usage().catch(() => undefined)
    if (u) await anotarUso($, u.context, u.rateLimits)
  }
  if (agora - ultimaSessao >= 5_000) {
    ultimaSessao = agora
    await trocarSessoes($, agora, true)
  }

  // 7. o relógio do painel: redesenha (barras até "agora")
  await update($, relogio, () => agora)
}

/** Publica o resumo desta sessão no $.store (se `publica`) e traz o das outras para o estado. */
async function trocarSessoes($: any, agora: number, publica: boolean): Promise<void> {
  if (!idSessao) idSessao = await $.session.id()
  const minha = chaveSessao(idSessao)
  if (publica) {
    const m = await lerModelo($)
    await $.store.set(minha, resumoSessao(m, idSessao, m.principal.titulo || nomeSessao || 'Sessão')) // título do app (sobrevive à recarga) antes do nome de reserva
  }
  const entradas: [string, unknown][] = []
  for (const k of (await $.store.keys()) as string[]) if (ehSessao(k) && k !== minha) entradas.push([k, await $.store.get(k)])
  const { outras, apagar } = separar(entradas, agora)
  for (const k of apagar) await $.store.delete(k).catch(() => undefined)
  if (sessoesMudaram(outras, await read($, sessoes), agora)) await update($, sessoes, () => outras)
}

// ---------- ações dos botões ----------

async function abrir($: any, id: string): Promise<void> {
  await update($, aberto, v => (v === id ? '' : id))
}

async function dispensar($: any, ids: string[]): Promise<void> {
  await update($, vistos, v => [...new Set([...v, ...ids])].slice(-300))
  const ps: Record<string, Pendente> = await read($, pendentes)
  const apagaveis = ids.filter(i => ps[i]?.tipo === 'falha-api')
  if (apagaveis.length) await tirarPendentes($, apagaveis)
}

const SISTEMA = `Você explica o que um trabalho do computador fez (comando, agente ou workflow) para uma pessoa leiga em programação.
Português do Brasil, com precisão técnica, tom adulto e direto. Defina cada termo técnico em poucas palavras na primeira vez que aparecer. No máximo 120 palavras.
Estrutura em markdown: **O que faz**, **O que a saída diz**, e **Por que deu erro** só se houve erro.
Responda APENAS um JSON válido, sem cercas de código: {"explicacao": "<markdown>", "termos": [{"termo": "<palavra>", "definicao": "<uma frase>"}]}, com até 4 termos técnicos que apareceram.`

async function mudar($: any, id: string, m: Partial<Trabalhador>): Promise<void> {
  await update($, trabalhadores, ts => (ts[id] ? { ...ts, [id]: { ...ts[id]!, ...m } } : ts))
}

/** Haiku explica o trabalhador; os termos novos vão para o glossário (só os termos ficam em disco). */
async function explicar($: any, id: string): Promise<void> {
  const t: Trabalhador | undefined = ((await read($, trabalhadores)) as Ts)[id]
  if (!t || t.explicando) return
  await mudar($, id, { explicando: true })
  let explicacao = 'Não consegui explicar agora.'
  let termos: { termo: string; definicao: string }[] = []
  try {
    const prompt = [
      `Tipo: ${t.tipo}`,
      `Nome técnico: ${t.rotulo}`,
      `O que foi pedido: ${t.tarefa || '(não informado)'}`,
      `Situação: ${t.situacao === 'rodando' ? 'ainda rodando' : t.situacao === 'falhou' ? 'terminou com ERRO' : t.situacao === 'parado' ? 'foi interrompido' : 'terminou sem erro'}`,
      `Últimas ações: ${t.acoes.slice(-8).map(a => a.texto).join('; ') || '(nenhuma)'}`,
      `Últimas linhas da saída:\n${(t.cauda ?? []).join('\n') || '(sem saída)'}`,
    ].join('\n')
    const r = await $.model.complete({ model: 'haiku', system: SISTEMA, prompt, maxTokens: 900 })
    if (!r.isAnswered) explicacao = `Não consegui explicar (${r.reason}).`
    else {
      try {
        const j = JSON.parse(String(r.text).replace(/^```(?:json)?\s*|\s*```$/g, ''))
        explicacao = String(j.explicacao ?? explicacao)
        termos = Array.isArray(j.termos) ? j.termos.filter((x: any) => x?.termo && x?.definicao) : []
      } catch {
        explicacao = String(r.text)
      }
    }
  } catch (err: any) {
    // O motivo aparece no cartão: sem ele, "não funciona" fica sem pista.
    explicacao = `Não consegui explicar: ${String(err?.message ?? err).slice(0, 160)}`
  } finally {
    await mudar($, id, { explicando: false, explicacao })
  }
  if (!termos.length) return
  await update($, glossario, g => {
    const ja = new Set(g.map(x => x.termo.toLowerCase()))
    return [...g, ...termos.filter(x => !ja.has(String(x.termo).toLowerCase())).map(x => ({ termo: String(x.termo), definicao: String(x.definicao) }))]
  })
  await $.store.set('glossario', await read($, glossario))
}

/**
 * Para o trabalhador: tarefa em segundo plano (comando, workflow, subagente) por TaskStop; chamada em primeiro
 * plano do principal por $.turn.abort. Dentro de agente em primeiro plano não há como parar só ela: não faz nada.
 */
async function parar($: any, id: string): Promise<void> {
  const t: Trabalhador | undefined = ((await read($, trabalhadores)) as Ts)[id]
  if (!t || t.situacao !== 'rodando') return
  try {
    if (t.tarefaFundo) await $.tool.call({ tool: 'TaskStop', task_id: t.tarefaFundo })
    else if (t.pai === 'principal' && turnoPrincipal) await $.turn.abort({ turnId: turnoPrincipal })
    else return
  } catch {
    return
  }
  const fim: number = await $.clock.now()
  await update($, trabalhadores, atual =>
    atual[id]?.situacao === 'rodando' ? fecharFilhos({ ...atual, [id]: { ...atual[id]!, situacao: 'parado', fim } }, id, fim, 'parado') : atual)
}

async function alternar($: any, chave: 'historicoAberto' | 'sessoesAbertas' | 'verGlossario'): Promise<void> {
  if (chave === 'historicoAberto') await update($, historicoAberto, v => !v)
  else if (chave === 'sessoesAbertas') await update($, sessoesAbertas, v => !v)
  else await update($, verGlossario, v => !v)
}

/** Todo o estado num objeto só; lido pelo render, assina o redesenho (inclusive o relógio). */
async function lerModelo($: any): Promise<Modelo> {
  const [, agora, ts, wf, pe, vi, us, pr, ss, ab, ha, sa, vg, gl] = await Promise.all([
    read($, relogio),
    $.clock.now() as Promise<number>,
    read($, trabalhadores),
    read($, workflows),
    read($, pendentes),
    read($, vistos),
    read($, uso),
    read($, principal),
    read($, sessoes),
    read($, aberto),
    read($, historicoAberto),
    read($, sessoesAbertas),
    read($, verGlossario),
    read($, glossario),
  ])
  return {
    agora,
    trabalhadores: ts,
    workflows: wf,
    pendentes: pe,
    vistos: vi,
    uso: us,
    principal: pr,
    sessoes: (ss as ResumoSessao[]).filter(s => agora - s.t <= FRESCA),
    aberto: ab,
    historicoAberto: ha,
    sessoesAbertas: sa,
    verGlossario: vg,
    glossario: gl,
  }
}

// ---------- ligação: todos os ganchos do mod (register.tsx só chama ligar) ----------

let ligado = false
const nada = () => undefined

/** Relógio e comandos, uma vez por carga do módulo: a recarga quente derruba o relógio e não repete session.start. */
async function garantir($: any): Promise<void> {
  if (ligado) return
  ligado = true
  $.clock.every(2000, () => void tique($))
  await $.command.register({ name: 'painel', description: 'Abre o painel com o que está rodando agora' })
  await $.command.register({ name: 'glossario', description: 'Mostra o glossário de termos explicados no painel' })
}

export function ligar(on: any): void {
  on('session.start', async ($: any, e: any, next: any) => {
    const r = await next(e)
    await iniciar($).catch(nada)
    await garantir($).catch(nada)
    void $.ui.open({ id: PANE, title: 'Painel' })
    return r
  })
  on('session.end', async ($: any, e: any, next: any) => {
    await encerrar($, e.sessionId).catch(nada)
    return next(e)
  })
  on('command.run', { command: 'painel' }, async ($: any) => {
    await $.ui.open({ id: PANE, title: 'Painel' })
    return { text: 'Painel aberto.' }
  })
  on('command.run', { command: 'glossario' }, async ($: any) => ({ text: await textoGlossario($) }))

  on('session.measure', async ($: any, e: any, next: any) => {
    await anotarUso($, e.context, e.rateLimits).catch(nada)
    return next(e)
  })
  on('turn.start', async ($: any, e: any, next: any) => {
    await garantir($).catch(nada)
    await aoComecarTurno($, e).catch(nada)
    return next(e)
  })
  // Só observa: cada trecho vai à memória do módulo e o fluxo segue intacto.
  on('turn.step', async function* ($: any, e: any, next: any) {
    comecarPedido(e.agentId, e.model)
    try {
      for await (const c of next(e)) {
        try { trecho(e.agentId, c) } catch {}
        yield c
      }
    } finally {
      fimPedido(e.agentId)
    }
  })
  on('turn.complete', async ($: any, e: any, next: any) => {
    const r = await next(e)
    await aoTerminarTurno($, e).catch(nada)
    return r
  })
  on('agent.spawn', ($: any, e: any, next: any) => aoNascerAgente($, e, next)).catch(($: any, e: any, next: any) => next(e))
  on('tool.call', async ($: any, e: any, next: any) => {
    await garantir($).catch(nada)
    return aoChamar($, e, next)
  }).catch(($: any, e: any, next: any) => next(e))
  on('prompt.submit', async ($: any, e: any, next: any) => {
    await aoReceberPrompt($, e).catch(nada)
    return next(e)
  }).catch(($: any, e: any, next: any) => next(e))

  // Eventos clássicos: só observam (nunca decidem pela pessoa).
  on('classic.PermissionRequest', async ($: any, e: any, next: any) => {
    const id = await anotarPermissao($, e).catch(() => '')
    const r = await next(e)
    if (id && r?.decision) await tirarPendentes($, [id]).catch(nada) // outro gancho já respondeu: não espera ninguém
    return r
  }).catch(($: any, e: any, next: any) => next(e))
  on('classic.PermissionDenied', async ($: any, e: any, next: any) => {
    await negarPermissao($, e).catch(nada)
    return next(e)
  }).catch(($: any, e: any, next: any) => next(e))
  on('classic.StopFailure', async ($: any, e: any, next: any) => {
    await anotarFalhaApi($, e).catch(nada)
    return next(e)
  })
  on('classic.Stop', async ($: any, e: any, next: any) => {
    anotarArquivo(e)
    await aoParar($, e).catch(nada)
    return next(e)
  }).catch(($: any, e: any, next: any) => next(e))
  on('classic.SessionStart', async ($: any, e: any, next: any) => {
    anotarArquivo(e)
    await anotarTitulo($, e.session_title).catch(nada)
    return next(e)
  })
  on('classic.UserPromptSubmit', async ($: any, e: any, next: any) => {
    anotarArquivo(e)
    await anotarTitulo($, e.session_title).catch(nada)
    return next(e)
  }).catch(($: any, e: any, next: any) => next(e))

  // O render só lê; os botões chamam as ações deste arquivo, presas ao $ do desenho.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($: any, e: any) => {
    const m = await lerModelo($)
    const acoes: Acoes = {
      abrir: id => abrir($, id),
      dispensar: ids => dispensar($, ids),
      explicar: id => explicar($, id),
      parar: id => parar($, id),
      alternar: chave => alternar($, chave),
    }
    return desenharPainel($.ui.resolve(e), e, m, acoes)
  })
}

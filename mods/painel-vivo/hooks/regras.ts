// Regras do painel: funções PURAS que derivam veredito, atenções, árvore e textos do Modelo.
// Sem $, sem relógio próprio (tudo parte de m.agora), só tipos de '../types'. Textos adultos e sóbrios.
import type { Acao, Atencao, Linha, Modelo, ResumoSessao, Trabalhador, Veredito } from '../types'

export const LIMITES = { calado: 90_000, travado: 300_000, recolher: 10_000, raias: 8, avisos: 3, pendencias: 3, contexto: 80 }

// ---------- formatação ----------

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`
const corta = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s)
// Só o nome do arquivo, sem caminho nem aspas.
const base = (s: unknown) => String(s ?? '').trim().split(/[\\/]/).pop()!.replace(/["']/g, '').slice(0, 40)

/** "45s", "2 min", "7min 47s", "12 min", "1h 05min". */
export function tempo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 10) return s % 60 ? `${m}min ${s % 60}s` : `${m} min`
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}min`
}
// Em frases ("sem sinal há 6 min") os segundos só atrapalham: arredonda para baixo no minuto.
const grosso = (ms: number) => (ms < 60_000 ? tempo(ms) : tempo(Math.floor(ms / 60_000) * 60_000))

/** "260 mil", "8,4 mi". */
export function mil(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 999_500) return `${Math.round(n / 1000)} mil`
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '').replace('.', ',')} mi`
}

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
/** "19:20" se for hoje; "seg 09:00" em outro dia. `agora` só existe para o teste. */
export function horaCurta(iso: string | number, agora: number = Date.now()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === new Date(agora).toDateString() ? hm : `${DIAS[d.getDay()]} ${hm}`
}
// "às 19:20" (hoje) ou "seg 09:00": completa frases como "Concluído …" e "renova …".
const quando = (t: string | number, agora: number) => {
  const h = horaCurta(t, agora)
  return /^\d/.test(h) ? `às ${h}` : h
}

// ---------- nomes ----------

const SUBAGENTES: Record<string, string> = {
  explore: 'Pesquisa',
  plan: 'Planejamento',
  'general-purpose': 'Assistente',
  'codex:codex-rescue': 'Revisor Codex',
  'claude-code-guide': 'Consulta',
}

// "face_branca" → "Face branca"; caminho de script vira só o nome do arquivo.
function humanizar(s: string): string {
  let x = String(s ?? '').trim()
  if (/^(?:[A-Za-z]:)?[\\/]|[\\/][^\\/\s]+\.\w+$/.test(x)) x = x.split(/[\\/]/).pop()!.replace(/\.\w+$/, '')
  x = x.replace(/([\p{L}\p{N}])[_-]+(?=[\p{L}\p{N}])/gu, '$1 ')
  return x.charAt(0).toUpperCase() + x.slice(1)
}

/** "Pesquisa", "Assistente Gemini", "Revisor Codex", "Comando: Fatia o modelo", "Face branca". */
/** "claude-sonnet-5-5" → "Sonnet 5.5"; "Gemini 3.8 Flash (High)" → "Gemini 3.8 Flash"; outros como vieram. */
export function modeloCurto(m: string): string {
  const c = /(opus|sonnet|haiku|fable)[-\s]?(\d+)?(?:[-.](\d+))?/i.exec(m)
  if (c) {
    const nome = c[1]![0]!.toUpperCase() + c[1]!.slice(1).toLowerCase()
    return c[2] ? `${nome} ${c[2]}${c[3] ? '.' + c[3] : ''}` : nome
  }
  return m.replace(/\s*\((high|low|medium|thinking)\)/i, '').trim()
}

/** Quem trabalha e quanto gastou, para a 2ª linha da raia: "Sonnet 5.5 · 71 mil tokens". Vazio se não há o que dizer. */
export function quemGasta(t: Trabalhador, filhos: Trabalhador[] = []): string {
  const tok = (x: Trabalhador) => (x.tokensNovos ?? 0) + (x.tokensCache ?? 0)
  if (t.tipo === 'workflow') {
    const soma = filhos.filter(f => f.tipo === 'agente-wf').reduce((s, f) => s + tok(f), 0)
    return soma ? `${mil(soma)} tokens` : ''
  }
  if (t.tipo === 'comando' || t.tipo === 'pergunta') return ''
  const modelo = t.modelo ? modeloCurto(t.modelo) : t.tipo === 'codex' ? 'modelo padrão' : ''
  const tokens = t.tipo === 'codex' ? '' : tok(t) ? `${mil(tok(t))} tokens` : ''
  return [modelo, tokens].filter(Boolean).join(' · ')
}

export function nomeHumano(t: Trabalhador): string {
  const r = String(t.rotulo ?? '')
  switch (t.tipo) {
    case 'subagente':
      return SUBAGENTES[r.toLowerCase()] ?? (humanizar(r.split(':').pop()!) || 'Assistente')
    case 'agente-wf':
      return humanizar(r) || 'Agente'
    case 'workflow':
      return humanizar(r) || 'Workflow'
    case 'comando':
      return r ? `Comando: ${corta(r, 44)}` : 'Comando'
    case 'agy':
      // O agy também roda Claude quando a cota do Gemini acaba: não rotular errado.
      return /claude|sonnet|opus|haiku/i.test(t.modelo ?? '') ? 'Assistente Claude' : 'Assistente Gemini'
    case 'codex':
      return 'Revisor Codex'
    case 'pergunta':
      return 'Pergunta ao usuário'
    default:
      return humanizar(r)
  }
}

/** #1/#2 só entre irmãos (mesmo pai) de mesmo nome humano, na ordem de início. */
export function ordinais(ts: Trabalhador[]): Map<string, number> {
  const grupos = new Map<string, Trabalhador[]>()
  for (const t of ts) {
    const k = `${t.pai}\u0000${nomeHumano(t)}`
    const g = grupos.get(k)
    if (g) g.push(t)
    else grupos.set(k, [t])
  }
  const out = new Map<string, number>()
  for (const g of grupos.values()) {
    if (g.length < 2) continue
    g.sort((a, b) => a.inicio - b.inicio || (a.id < b.id ? -1 : 1)).forEach((t, i) => out.set(t.id, i + 1))
  }
  return out
}

/** Milissegundos de silêncio; 0 se não está rodando. */
export function calado(t: Trabalhador, agora: number): number {
  return t.situacao === 'rodando' ? Math.max(0, agora - t.ultimoSinal) : 0
}

// ---------- o que o agente faz, em português simples ----------

/** Ferramenta + entrada → tipo da ação e texto sem caminho completo ("lendo corners.png"). */
export function acaoDe(ferramenta: string, entrada: any): { tipo: Acao['tipo']; texto: string } {
  const e = entrada ?? {}
  const arq = base(e.file_path ?? e.path ?? e.notebook_path)
  const desc = e.description ? String(e.description) : ''
  switch (ferramenta) {
    case 'Read':
    case 'NotebookRead':
      return { tipo: 'leitura', texto: arq ? `lendo ${arq}` : 'lendo um arquivo' }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { tipo: 'edicao', texto: arq ? `editando ${arq}` : 'editando um arquivo' }
    case 'Write':
      return { tipo: 'edicao', texto: arq ? `escrevendo ${arq}` : 'escrevendo um arquivo' }
    case 'Grep':
      return { tipo: 'busca', texto: 'procurando nos arquivos' }
    case 'Glob':
      return { tipo: 'busca', texto: 'listando arquivos' }
    case 'Bash':
    case 'PowerShell':
      return { tipo: 'comando', texto: desc ? corta(desc, 60) : 'rodando um comando' }
    case 'WebFetch':
    case 'WebSearch':
      return { tipo: 'web', texto: 'pesquisando na internet' }
    case 'Agent':
    case 'Task':
      return { tipo: 'agente', texto: desc ? `chamando um ajudante · ${corta(desc, 40)}` : 'chamando um ajudante' }
    case 'Workflow':
      return { tipo: 'agente', texto: 'iniciando um workflow' }
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
      return { tipo: 'outro', texto: 'atualizando o plano' }
    case 'AskUserQuestion':
      return { tipo: 'outro', texto: 'fazendo uma pergunta' }
    case 'ExitPlanMode':
      return { tipo: 'outro', texto: 'apresentando o plano' }
    case 'ToolSearch':
      return { tipo: 'outro', texto: 'buscando ferramentas' }
    case 'Skill':
      return { tipo: 'outro', texto: 'usando uma skill' }
    default:
      return { tipo: 'outro', texto: ferramenta.startsWith('mcp__') ? 'usando uma ferramenta externa' : `usando ${ferramenta}` }
  }
}

// Passos do agy ("tool: parâmetro", "pensando"…) em português simples. O que não estiver aqui passa como veio.
const PASSOS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^run_command/, () => 'rodando um comando'],
  [/^(?:view_file|read_file)\w*:?\s*(.*)/, m => `lendo ${base(m[1]) || 'um arquivo'}`],
  [/^list_dir/, () => 'listando a pasta'],
  [/^(?:grep_search|search_files|find_by_name)/, () => 'procurando nos arquivos'],
  [/^(?:write_to_file|create_file)\w*:?\s*(.*)/, m => `escrevendo ${base(m[1]) || 'um arquivo'}`],
  [/^(?:replace_file_content|multi_replace_file_content|edit_file)\w*:?\s*(.*)/, m => `editando ${base(m[1]) || 'um arquivo'}`],
  [/^(?:search_web|read_url_content|web_)/, () => 'pesquisando na internet'],
  [/^browser_/, () => 'usando o navegador'],
  [/^generate_image/, () => 'gerando uma imagem'],
  [/^ask_/, () => 'esperando permissão'],
  [/^pensando/, () => 'pensando'],
  [/^escrevendo a resposta/, () => 'escrevendo a resposta'],
]

/** "view_file: main.py" → "lendo main.py". Ferramenta desconhecida vira "usando <nome>". */
export function traduzirPassoAgy(passo: string): string {
  const p = String(passo ?? '').trim()
  for (const [re, f] of PASSOS) {
    const m = re.exec(p)
    if (m) return f(m)
  }
  const desconhecida = /^([a-z]+(?:_\w+)+)/i.exec(p)
  return desconhecida ? `usando ${desconhecida[1]!.replace(/_/g, ' ')}` : p
}

// ---------- fatos sobre os trabalhadores ----------

function indice(m: Modelo) {
  const lista = Object.values(m.trabalhadores)
  const filhos = new Map<string, Trabalhador[]>()
  for (const t of lista) {
    const g = filhos.get(t.pai)
    if (g) g.push(t)
    else filhos.set(t.pai, [t])
  }
  return { lista, filhos }
}

type Filhos = Map<string, Trabalhador[]>

// Algum descendente de t cumpre o teste? (guarda contra ciclo, caso o estado venha torto)
function desce(filhos: Filhos, t: Trabalhador, teste: (f: Trabalhador) => boolean, visto = new Set<string>()): boolean {
  for (const f of filhos.get(t.id) ?? []) {
    if (visto.has(f.id)) continue
    visto.add(f.id)
    if (teste(f) || desce(filhos, f, teste, visto)) return true
  }
  return false
}

const rodando = (t: Trabalhador) => t.situacao === 'rodando'

// Falha que merece aviso: agentes, workflow, agy, Codex, comando ≥ 5 s ou em fundo. Comando curto com exit≠0 não.
function importante(t: Trabalhador, agora: number): boolean {
  if (t.tipo === 'pergunta') return false
  if (t.tipo !== 'comando') return true
  return !!t.emFundo || (t.fim ?? agora) - t.inicio >= 5000
}

type Estado = 'ativo' | 'calado' | 'travado' | 'espera'

// ---------- atenções ----------

const PESO_PEND: Record<string, number> = { permissao: 0, pergunta: 0, plano: 0, 'falha-api': 1, travado: 2, sessao: 3 }
const PESO_AVISO: Record<string, number> = { erro: 0, calado: 1, contexto: 2, cota: 3 }

// Tudo o que pede atenção, ordenado por gravidade e depois por idade, mais as "frentes" de onde vêm os números.
// `comSessoes` = false para o resumo que esta sessão publica (não repassar pendência alheia).
function coletar(m: Modelo, comSessoes = true) {
  const { lista, filhos } = indice(m)
  const ord = ordinais(lista)
  const vistos = new Set(m.vistos)
  const esperaPessoa = new Set(Object.values(m.pendentes).map(p => p.quem))
  const nome = (t: Trabalhador) => nomeHumano(t) + (ord.has(t.id) ? ` #${ord.get(t.id)}` : '')
  const pend: Atencao[] = []
  const avis: Atencao[] = []
  const frentes: { t: Trabalhador; est: Estado }[] = []

  for (const p of Object.values(m.pendentes)) {
    if (p.tipo === 'falha-api' && vistos.has(p.id)) continue
    pend.push({ id: p.id, nivel: 'pendencia', tipo: p.tipo, titulo: p.titulo, detalhe: p.detalhe, quem: p.quem, desde: p.desde, acoes: p.tipo === 'falha-api' ? ['dispensar'] : [] })
  }

  for (const t of lista) {
    if (t.situacao === 'falhou' && !vistos.has(t.id) && importante(t, m.agora)) {
      let detalhe: string | undefined
      for (const a of [...t.acoes].reverse()) if (a.erro) { detalhe = a.texto; break }
      avis.push({ id: t.id, nivel: 'aviso', tipo: 'erro', titulo: `${nome(t)} falhou`, detalhe, quem: t.id, desde: t.fim ?? t.ultimoSinal, acoes: ['explicar', 'dispensar'] })
    }
    // Quem só espera filhos ativos não é "frente" nem fica calado: os filhos é que mostram o sinal.
    if (!rodando(t) || t.tipo === 'pergunta' || (filhos.get(t.id) ?? []).some(rodando)) continue
    const c = calado(t, m.agora)
    const est: Estado = esperaPessoa.has(t.id) ? 'espera' : c > LIMITES.travado ? 'travado' : c > LIMITES.calado ? 'calado' : 'ativo'
    frentes.push({ t, est })
    if (est === 'travado' && !vistos.has(`travado:${t.id}`)) {
      pend.push({ id: `travado:${t.id}`, nivel: 'pendencia', tipo: 'travado', titulo: `${nome(t)} sem sinal há ${grosso(c)}`, quem: t.id, desde: t.ultimoSinal, acoes: ['parar', 'esperar'] })
    } else if (est === 'calado' && !vistos.has(`calado:${t.id}`)) {
      avis.push({ id: `calado:${t.id}`, nivel: 'aviso', tipo: 'calado', titulo: `${nome(t)} sem sinal há ${grosso(c)}`, quem: t.id, desde: t.ultimoSinal, acoes: ['esperar', 'parar'] })
    }
  }

  const ctx = m.uso.contextoPct
  if (ctx !== undefined && ctx >= LIMITES.contexto) {
    const id = `contexto:${Math.floor(ctx / 10) * 10}`
    if (!vistos.has(id)) avis.push({ id, nivel: 'aviso', tipo: 'contexto', titulo: `Contexto em ${Math.round(ctx)}% · a conversa será resumida em breve`, desde: m.agora, acoes: ['dispensar'] })
  }
  for (const [chave, rotulo, pct, renova] of [
    ['cota5h', 'Cota de 5h', m.uso.cota5h, m.uso.renova5h],
    ['cotaSemana', 'Cota de 7 dias', m.uso.semana, m.uso.renovaSemana],
  ] as const) {
    if (pct === undefined || pct < LIMITES.contexto) continue
    // Um aviso por faixa (80, 90, 100) em cada janela da cota: a hora de renovação separa as janelas,
    // senão o "visto" dos 80% de ontem calaria os 80% de hoje.
    const id = `${chave}:${renova ?? ''}:${Math.floor(pct / 10) * 10}`
    if (vistos.has(id)) continue
    avis.push({ id, nivel: 'aviso', tipo: 'cota', titulo: `${rotulo} em ${Math.round(pct)}%` + (renova ? ` · renova ${quando(renova, m.agora)}` : ''), desde: m.agora, acoes: ['dispensar'] })
  }

  if (comSessoes) {
    for (const s of m.sessoes) {
      if (s.nivel !== 'pendencia') continue
      pend.push({ id: `sessao:${s.id}`, nivel: 'pendencia', tipo: 'sessao', titulo: `Sessão ${s.nome}: ${s.pendencias[0] ?? 'aguarda resposta'}`, detalhe: s.pendencias.slice(1).join(' · ') || undefined, desde: 0, acoes: [] }) // desde 0 = não se sabe (o desenho esconde a idade)
    }
  }

  pend.sort((a, b) => (PESO_PEND[a.tipo] ?? 9) - (PESO_PEND[b.tipo] ?? 9) || a.desde - b.desde)
  avis.sort((a, b) => (PESO_AVISO[a.tipo] ?? 9) - (PESO_AVISO[b.tipo] ?? 9) || a.desde - b.desde)
  return { pend, avis, frentes, lista, filhos }
}

/** Pendências (máx 3) e avisos (máx 3), com o que sobrou contado em "mais N". */
export function atencoes(m: Modelo): { pendencias: Atencao[]; avisos: Atencao[]; maisPendencias: number; maisAvisos: number } {
  const { pend, avis } = coletar(m)
  return {
    pendencias: pend.slice(0, LIMITES.pendencias),
    avisos: avis.slice(0, LIMITES.avisos),
    maisPendencias: Math.max(0, pend.length - LIMITES.pendencias),
    maisAvisos: Math.max(0, avis.length - LIMITES.avisos),
  }
}

// ---------- veredito ----------

const TIPO_PEND: Record<string, string> = { permissao: 'permissão', pergunta: 'pergunta', plano: 'plano', 'falha-api': 'falha de API', travado: 'sem sinal', sessao: 'outra sessão' }

function assunto(m: Modelo, lista: Trabalhador[]): string {
  const wf = lista.find(t => t.tipo === 'workflow' && rodando(t))
  const w = wf ? m.workflows[wf.id] : undefined
  // Descrição do workflow até a primeira pausa (":", "—", ";"), cortada em palavra inteira; o nome técnico só na falta dela.
  const desc = w?.desc?.split(/\s*[:;—]\s/)[0]?.trim()
  const txt = desc || (w && humanizar(w.nome)) || (wf && humanizar(wf.rotulo)) || m.principal.titulo || 'trabalho do Claude'
  return txt.length > 40 ? txt.slice(0, 40).replace(/\s+\S*$/, '') + '…' : txt
}

function ultimoTrabalho(m: Modelo, lista: Trabalhador[]): string {
  if (!lista.length) return m.principal.fimTurno ? 'sem ajudantes' : 'sem trabalho em curso'
  const ag = lista.filter(t => ['subagente', 'agente-wf', 'agy', 'codex'].includes(t.tipo)).length
  const cm = lista.filter(t => t.tipo === 'comando').length
  const ini = Math.min(...lista.map(t => t.inicio))
  const fim = Math.max(...lista.map(t => t.fim ?? t.ultimoSinal))
  return [ag && plural(ag, 'agente', 'agentes'), cm && plural(cm, 'comando', 'comandos'), tempo(fim - ini)].filter(Boolean).join(' · ')
}

type Tile = Veredito['tiles'][number]

function progresso(m: Modelo, lista: Trabalhador[], filhos: Filhos): Tile {
  const rotulo = 'Progresso'
  const p = m.principal.plano
  if (p && p.total > 0) {
    if (p.feitos >= p.total) return { rotulo, valor: `${p.total} de ${p.total}`, detalhe: 'plano concluído', nivel: 'ok' }
    return { rotulo, valor: `passo ${p.feitos + 1} de ${p.total}`, detalhe: p.atual ? corta(p.atual, 40) : 'plano do Claude', nivel: 'neutro' }
  }
  const wf = lista.filter(t => t.tipo === 'workflow' && rodando(t)).sort((a, b) => a.inicio - b.inicio)[0]
  const ags = wf ? (filhos.get(wf.id) ?? []).filter(t => t.tipo === 'agente-wf') : []
  if (ags.length) {
    const prontos = ags.filter(t => !rodando(t)).length
    const fase = [...ags].reverse().find(t => rodando(t) && t.fase)?.fase
    return { rotulo, valor: `${prontos} de ${ags.length} prontos`, detalhe: fase ? corta(fase, 40) : 'workflow', nivel: 'neutro' }
  }
  const cmd = lista.find(t => t.tipo === 'comando' && rodando(t) && t.pct !== undefined)
  if (cmd) return { rotulo, valor: `${Math.round(cmd.pct!)}%`, detalhe: corta(nomeHumano(cmd), 40), nivel: 'neutro' }
  return { rotulo, valor: '—', detalhe: 'sem plano declarado', nivel: 'neutro' }
}

/** Manchete, subtítulo e os 3 tiles (Pendências, Atividade, Progresso), todos derivados dos mesmos números. */
export function veredito(m: Modelo): Veredito {
  const { pend, avis, frentes, lista, filhos } = coletar(m)
  const np = pend.length
  const na = avis.length
  const n = frentes.length
  const semSinal = frentes.filter(f => f.est === 'calado' || f.est === 'travado').length
  const espera = frentes.filter(f => f.est === 'espera').length
  const ativos = n - semSinal - espera
  const algoRoda = n > 0 || m.principal.ocupado
  const nivel: Veredito['nivel'] = np ? 'pendencia' : na ? 'aviso' : algoRoda ? 'andando' : 'ocioso'

  const concluido = m.principal.fimTurno ? `Concluído ${quando(m.principal.fimTurno, m.agora)}` : 'Sem atividade'
  const frentesTxt = n ? plural(n, 'frente', 'frentes') : 'Claude trabalhando'
  let manchete: string
  let sub: string
  if (nivel === 'pendencia') {
    manchete = plural(np, 'pendência', 'pendências')
    sub = pend.slice(0, 2).map(a => corta(a.titulo, 46)).join(' · ')
  } else if (algoRoda) {
    manchete = `Em andamento · ${assunto(m, lista)}`
    sub = `${frentesTxt} · ${na ? plural(na, 'aviso', 'avisos') : 'sem pendências'}`
  } else {
    manchete = concluido
    sub = [na ? plural(na, 'aviso', 'avisos') : '', ultimoTrabalho(m, lista)].filter(Boolean).join(' · ')
  }

  const pendencias: Tile = {
    rotulo: 'Pendências',
    valor: String(np),
    detalhe: np ? [...new Set(pend.map(a => TIPO_PEND[a.tipo]))].slice(0, 3).join(', ') : na ? plural(na, 'aviso', 'avisos') : 'sem avisos',
    nivel: np ? 'pendencia' : na ? 'aviso' : 'ok',
  }
  const haTrabalho = lista.length > 0 || !!m.principal.fimTurno
  const atividade: Tile = n
    ? {
        rotulo: 'Atividade',
        valor: semSinal ? `${n - semSinal} de ${n} com sinal` : `${ativos} trabalhando`,
        detalhe: [semSinal && `${semSinal} sem sinal`, espera && `${espera} aguardando resposta`].filter(Boolean).join(', ') || 'todos com sinal',
        nivel: semSinal ? 'aviso' : 'ok',
      }
    : m.principal.ocupado
      ? { rotulo: 'Atividade', valor: 'em andamento', detalhe: 'sem ajudantes', nivel: 'ok' }
      : haTrabalho
        ? { rotulo: 'Atividade', valor: 'concluído', detalhe: m.principal.fimTurno ? quando(m.principal.fimTurno, m.agora) : 'sem trabalho em curso', nivel: 'ok' }
        : { rotulo: 'Atividade', valor: '—', detalhe: 'sem atividade', nivel: 'neutro' }

  return { nivel, manchete, sub, tiles: [pendencias, atividade, progresso(m, lista, filhos)] }
}

/** Resumo desta sessão para as outras verem: só o que é daqui (sem repassar pendência de terceiros). */
export function resumoSessao(m: Modelo, id: string, nome: string): ResumoSessao {
  const { pend, frentes } = coletar(m, false)
  const nivel = pend.length ? 'pendencia' : frentes.length || m.principal.ocupado ? 'andando' : 'ocioso'
  return { id, nome, nivel, frentes: frentes.length, pendencias: pend.slice(0, 5).map(a => corta(a.titulo, 60)), t: m.agora }
}

// ---------- árvore "Em execução" ----------

const textoResumo = (sit: 'feito' | 'rodando' | 'falhou', n: number) =>
  sit === 'rodando' ? `+${n} em execução` : sit === 'falhou' ? `+${n} com falha` : n === 1 ? '+1 pronto' : `+${n} prontos`

/**
 * Pré-ordem por pai, rodando primeiro. No máximo LIMITES.raias linhas de trabalhador: as raias vão por
 * prioridade (falha nova, agy/Codex/comando, subagente, agente de workflow, recém-concluído), sempre com os
 * pais para a árvore não se partir. O que não ganha raia (e o concluído há mais de 10 s) vira, por pai,
 * "+N em execução" / "+N com falha" / "+N prontos".
 */
export function arvore(m: Modelo): Linha[] {
  const { lista, filhos } = indice(m)
  const ord = ordinais(lista)
  const vistos = new Set(m.vistos)
  const porId = new Map(lista.map(t => [t.id, t]))
  const falhaNova = (t: Trabalhador) => t.situacao === 'falhou' && importante(t, m.agora) && !vistos.has(t.id)
  const proprio = (t: Trabalhador) => rodando(t) || falhaNova(t) || m.agora - (t.fim ?? t.ultimoSinal) <= LIMITES.recolher
  const visivel = (t: Trabalhador) => proprio(t) || desce(filhos, t, proprio) // visível ⇒ os pais também são
  // Falha de comando curto conta como pronto; falha vista de trabalhador importante, como falha.
  const bucket = (t: Trabalhador): 'feito' | 'rodando' | 'falhou' => (rodando(t) ? 'rodando' : t.situacao === 'falhou' && importante(t, m.agora) ? 'falhou' : 'feito')
  const peso = (t: Trabalhador) =>
    falhaNova(t) ? 0 : !rodando(t) ? 4 : ['agy', 'codex', 'comando', 'pergunta'].includes(t.tipo) ? 1 : t.tipo === 'agente-wf' ? 3 : 2

  const escolhidos = new Set<string>()
  for (const t of lista.filter(visivel).sort((a, b) => peso(a) - peso(b) || a.inicio - b.inicio)) {
    const cadeia: Trabalhador[] = []
    for (let x: Trabalhador | undefined = t; x && !escolhidos.has(x.id) && !cadeia.includes(x); x = porId.get(x.pai)) cadeia.push(x)
    if (escolhidos.size + cadeia.length <= LIMITES.raias) cadeia.forEach(x => escolhidos.add(x.id))
  }

  const saida: Linha[] = []
  const visitados = new Set<string>()
  const grupo = (irmaos: Trabalhador[], nivel: number) => {
    const quem = irmaos.filter(t => !visitados.has(t.id))
    const chave = new Map(quem.map(t => [t.id, [desce(filhos, t, rodando) ? 0 : rodando(t) ? 1 : falhaNova(t) ? 2 : 3, t.inicio] as const]))
    const mostrar = quem.filter(t => escolhidos.has(t.id)).sort((a, b) => chave.get(a.id)![0] - chave.get(b.id)![0] || chave.get(a.id)![1] - chave.get(b.id)![1])
    for (const t of mostrar) {
      visitados.add(t.id)
      saida.push({ tipo: 'trabalhador', t, nivel, nome: nomeHumano(t), ...(ord.has(t.id) ? { ordinal: ord.get(t.id) } : {}) })
      grupo(filhos.get(t.id) ?? [], nivel + 1)
    }
    const resto = quem.filter(t => !escolhidos.has(t.id))
    for (const sit of ['rodando', 'falhou', 'feito'] as const) {
      const ags = resto.filter(t => bucket(t) === sit)
      if (ags.length) saida.push({ tipo: 'resumo', nivel, texto: textoResumo(sit, ags.length), situacao: sit, ids: ags.map(t => t.id) })
    }
  }
  grupo(lista.filter(t => t.pai === 'principal' || !porId.has(t.pai)), 0)
  return saida
}

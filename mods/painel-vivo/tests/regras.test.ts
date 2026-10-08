// Testes das regras (funções puras): veredito, atenções, árvore, nomes e textos.
import { test, expect } from 'claude-code/testing'
import { modeloCurto, quemGasta, LIMITES, acaoDe, arvore, atencoes, calado, horaCurta, mil, nomeHumano, ordinais, resumoSessao, tempo, traduzirPassoAgy, veredito } from '../hooks/regras'
import { somaTokensAgy } from '../hooks/saida'
import type { Linha, Modelo, Pendente, Principal, Trabalhador } from '../types'

// ---------- fábricas ----------

const AGORA = new Date(2026, 9, 8, 15, 40, 0).getTime() // quinta-feira
const s = (seg: number) => AGORA - seg * 1000 // "há <seg> segundos"

function trab(o: Partial<Trabalhador> & Pick<Trabalhador, 'id' | 'tipo'>): Trabalhador {
  return { pai: 'principal', rotulo: '', agora: 'pensando', inicio: s(60), ultimoSinal: s(1), situacao: 'rodando', acoes: [], ...o }
}
const feito = (o: Partial<Trabalhador> & Pick<Trabalhador, 'id' | 'tipo'>, haSeg: number) => trab({ situacao: 'feito', fim: s(haSeg), ultimoSinal: s(haSeg), ...o })
const falhou = (o: Partial<Trabalhador> & Pick<Trabalhador, 'id' | 'tipo'>, haSeg: number) => trab({ situacao: 'falhou', fim: s(haSeg), ultimoSinal: s(haSeg), ...o })

const princ = (o: Partial<Principal> = {}): Principal => ({ ocupado: false, ultimoSinal: s(1), tokensNovos: 0, tokensCache: 0, acoes: [], ...o })
const pend = (o: Partial<Pendente> & Pick<Pendente, 'id' | 'tipo' | 'titulo'>): Pendente => ({ quem: 'principal', desde: s(30), ...o })

function modelo(ts: Trabalhador[] = [], o: Partial<Modelo> = {}): Modelo {
  return {
    agora: AGORA,
    trabalhadores: Object.fromEntries(ts.map(t => [t.id, t])),
    workflows: {},
    pendentes: {},
    vistos: [],
    uso: {},
    principal: princ(),
    sessoes: [],
    aberto: '',
    historicoAberto: false,
    sessoesAbertas: false,
    verGlossario: false,
    glossario: [],
    ...o,
  }
}

const doFluxo = { wf1: { id: 'wf1', nome: 'painel-vivo-v2-implementa', desc: 'Conserto da plataforma 3D', fases: [], fasePorAgente: {} } }

// Workflow com 4 agentes rodando e 1 pronto: 4 frentes.
function modeloAndando(extra: Trabalhador[] = [], o: Partial<Modelo> = {}): Modelo {
  const ags = [1, 2, 3, 4].map(i => trab({ id: `ag:${i}`, tipo: 'agente-wf', pai: 'wf1', rotulo: `agente_${i}`, fase: 'desenho', inicio: s(300 - i) }))
  return modelo([trab({ id: 'wf1', tipo: 'workflow', rotulo: 'painel-vivo-v2-implementa', inicio: s(400) }), feito({ id: 'ag:0', tipo: 'agente-wf', pai: 'wf1', rotulo: 'agente_0', fase: 'coleta' }, 100), ...ags, ...extra], {
    workflows: doFluxo,
    principal: princ({ ocupado: true }),
    ...o,
  })
}

// Texto da árvore, uma linha por item, recuada por nível.
const texto = (ls: Linha[]) => ls.map(l => '  '.repeat(l.nivel) + (l.tipo === 'trabalhador' ? l.nome + (l.ordinal ? ` #${l.ordinal}` : '') : l.texto))
const raias = (ls: Linha[]) => ls.filter(l => l.tipo === 'trabalhador').length

// ---------- veredito: 4 níveis, textos exatos ----------

test('veredito ocioso: concluído às HH:MM com o resumo do último trabalho', () => {
  const ags = [1, 2, 3, 4, 5, 6, 7].map(i => feito({ id: `ag:${i}`, tipo: 'agente-wf', pai: 'wf1', rotulo: `agente_${i}`, inicio: s(740) }, 20))
  const m = modelo(ags, { principal: princ({ fimTurno: new Date(2026, 9, 8, 15, 38).getTime(), plano: { feitos: 7, total: 7 } }) })
  expect(veredito(m)).toEqual({
    nivel: 'ocioso',
    manchete: 'Concluído às 15:38',
    sub: '7 agentes · 12 min',
    tiles: [
      { rotulo: 'Pendências', valor: '0', detalhe: 'sem avisos', nivel: 'ok' },
      { rotulo: 'Atividade', valor: 'concluído', detalhe: 'às 15:38', nivel: 'ok' },
      { rotulo: 'Progresso', valor: '7 de 7', detalhe: 'plano concluído', nivel: 'ok' },
    ],
  })
})

test('veredito ocioso sem nada: "Sem atividade"', () => {
  const v = veredito(modelo())
  expect(v.nivel).toBe('ocioso')
  expect(v.manchete).toBe('Sem atividade')
  expect(v.sub).toBe('sem trabalho em curso')
  expect(v.tiles.map(t => t.valor)).toEqual(['0', '—', '—'])
})

test('veredito ocioso de outro dia: "Concluído seg 09:00", sem "às"', () => {
  const fim = new Date(2026, 9, 5, 9, 0).getTime() // segunda
  expect(veredito(modelo([], { principal: princ({ fimTurno: fim }) })).manchete).toBe('Concluído seg 09:00')
})

test('veredito andando: "Em andamento · assunto" e "4 frentes · sem pendências"', () => {
  const v = veredito(modeloAndando())
  expect(v.nivel).toBe('andando')
  expect(v.manchete).toBe('Em andamento · Conserto da plataforma 3D')
  expect(v.sub).toBe('4 frentes · sem pendências')
})

test('veredito andando: assunto cai para o título da sessão e depois para "trabalho do Claude"', () => {
  const comTitulo = veredito(modelo([], { principal: princ({ ocupado: true, titulo: 'conserto do relógio' }) }))
  expect(comTitulo.manchete).toBe('Em andamento · conserto do relógio')
  const semNada = veredito(modelo([], { principal: princ({ ocupado: true }) }))
  expect(semNada.manchete).toBe('Em andamento · trabalho do Claude')
  expect(semNada.sub).toBe('Claude trabalhando · sem pendências')
})

test('veredito aviso: "4 frentes · 2 avisos"', () => {
  const m = modeloAndando([], { uso: { contextoPct: 85 } })
  m.trabalhadores['ag:4'] = trab({ id: 'ag:4', tipo: 'agente-wf', pai: 'wf1', rotulo: 'agente_4', inicio: s(300), ultimoSinal: s(100) }) // calado
  const v = veredito(m)
  expect(v.nivel).toBe('aviso')
  expect(v.manchete).toBe('Em andamento · Conserto da plataforma 3D')
  expect(v.sub).toBe('4 frentes · 2 avisos')
})

test('veredito aviso com tudo parado não diz "em andamento"', () => {
  const m = modelo([falhou({ id: 'x', tipo: 'subagente', rotulo: 'Explore', inicio: s(100) }, 20)], { principal: princ({ fimTurno: new Date(2026, 9, 8, 15, 39).getTime() }) })
  const v = veredito(m)
  expect(v.nivel).toBe('aviso')
  expect(v.manchete).toBe('Concluído às 15:39')
  expect(v.sub).toBe('1 aviso · 1 agente · 1min 20s')
})

test('veredito pendência: "N pendências" e os 2 primeiros títulos', () => {
  const m = modeloAndando([], {
    pendentes: {
      p1: pend({ id: 'p1', tipo: 'permissao', titulo: 'Permissão para rodar: apagar a pasta build', desde: s(30) }),
      p2: pend({ id: 'p2', tipo: 'pergunta', titulo: 'Qual material usar?', desde: s(20) }),
      p3: pend({ id: 'p3', tipo: 'plano', titulo: 'Aprovar o plano', desde: s(10) }),
    },
  })
  const v = veredito(m)
  expect(v.nivel).toBe('pendencia')
  expect(v.manchete).toBe('3 pendências')
  expect(v.sub).toBe('Permissão para rodar: apagar a pasta build · Qual material usar?')
  expect(v.tiles[0]).toEqual({ rotulo: 'Pendências', valor: '3', detalhe: 'permissão, pergunta, plano', nivel: 'pendencia' })
  expect(veredito(modelo([], { pendentes: { p1: pend({ id: 'p1', tipo: 'plano', titulo: 'Aprovar o plano' }) } })).manchete).toBe('1 pendência')
})

test('veredito: nenhuma das frases proibidas aparece em nenhum nível', () => {
  const proibidas = ['Merece um olho', 'Nada precisa de você', 'Preciso fazer algo', 'Nada te bloqueia', '!']
  const casos: Modelo[] = [
    modelo(),
    modeloAndando(),
    modeloAndando([], { uso: { contextoPct: 90 } }),
    modeloAndando([], { pendentes: { p: pend({ id: 'p', tipo: 'permissao', titulo: 'Permissão para rodar: x' }) } }),
    modelo([], { principal: princ({ fimTurno: s(60) }) }),
  ]
  for (const m of casos) {
    const v = veredito(m)
    const tudo = [v.manchete, v.sub, ...v.tiles.flatMap(t => [t.rotulo, t.valor, t.detalhe]), ...atencoes(m).avisos.map(a => a.titulo)].join(' | ')
    for (const p of proibidas) expect(tudo.includes(p)).toBe(false)
  }
})

// ---------- veredito: coerência dos 3 tiles ----------

test('tiles: sempre 3, e "N frentes" = "N trabalhando" ou "A de N com sinal" com o calado fora dos ativos', () => {
  const m = modeloAndando()
  m.trabalhadores['ag:4'] = trab({ id: 'ag:4', tipo: 'agente-wf', pai: 'wf1', rotulo: 'agente_4', inicio: s(300), ultimoSinal: s(100) })
  const v = veredito(m)
  expect(v.tiles.map(t => t.rotulo)).toEqual(['Pendências', 'Atividade', 'Progresso'])
  expect(v.sub.startsWith('4 frentes')).toBe(true)
  expect(v.tiles[1]).toEqual({ rotulo: 'Atividade', valor: '3 de 4 com sinal', detalhe: '1 sem sinal', nivel: 'aviso' })
  expect(v.tiles[0]?.valor).toBe('0')
  expect(v.tiles[0]?.detalhe).toBe('1 aviso')
})

test('tiles: quem espera os filhos não conta como frente; quem espera resposta não conta como ativo', () => {
  const m = modeloAndando([], { pendentes: { p1: pend({ id: 'p1', tipo: 'permissao', titulo: 'Permissão para rodar: x', quem: 'ag:2' }) } })
  expect(veredito(m).tiles[1]).toEqual({ rotulo: 'Atividade', valor: '3 trabalhando', detalhe: '1 aguardando resposta', nivel: 'ok' })
})

test('tile Progresso: plano do principal > workflow > comando com % > "—"', () => {
  const plano = modeloAndando([], { principal: princ({ ocupado: true, plano: { feitos: 2, total: 7, atual: 'Corrigindo o relógio' } }) })
  expect(veredito(plano).tiles[2]).toEqual({ rotulo: 'Progresso', valor: 'passo 3 de 7', detalhe: 'Corrigindo o relógio', nivel: 'neutro' })
  expect(veredito(modeloAndando()).tiles[2]).toEqual({ rotulo: 'Progresso', valor: '1 de 5 prontos', detalhe: 'desenho', nivel: 'neutro' })
  const cmd = modelo([trab({ id: 'c1', tipo: 'comando', rotulo: 'Baixa o áudio', pct: 63.4 })], { principal: princ({ ocupado: true }) })
  expect(veredito(cmd).tiles[2]).toEqual({ rotulo: 'Progresso', valor: '63%', detalhe: 'Comando: Baixa o áudio', nivel: 'neutro' })
  const nada = modelo([trab({ id: 'c1', tipo: 'comando', rotulo: 'Baixa o áudio' })], { principal: princ({ ocupado: true }) })
  expect(veredito(nada).tiles[2]).toEqual({ rotulo: 'Progresso', valor: '—', detalhe: 'sem plano declarado', nivel: 'neutro' })
})

// ---------- atenções ----------

test('atenção: comando curto com erro NÃO vira aviso; comando longo ou em fundo vira', () => {
  const curto = falhou({ id: 'c1', tipo: 'comando', rotulo: 'Procura um texto', inicio: s(11), acoes: [{ t: s(10), tipo: 'comando', texto: 'exit 1', erro: true }] }, 10) // 1 s
  expect(atencoes(modelo([curto])).avisos).toEqual([])
  const longo = falhou({ id: 'c2', tipo: 'comando', rotulo: 'Fatia o modelo', inicio: s(100), acoes: [{ t: s(10), tipo: 'comando', texto: 'arquivo não encontrado', erro: true }] }, 10) // 90 s
  const a = atencoes(modelo([longo])).avisos
  expect(a).toHaveLength(1)
  expect(a[0]).toMatchObject({ id: 'c2', nivel: 'aviso', tipo: 'erro', titulo: 'Comando: Fatia o modelo falhou', detalhe: 'arquivo não encontrado', quem: 'c2', acoes: ['explicar', 'dispensar'] })
  const fundo = falhou({ id: 'c3', tipo: 'comando', rotulo: 'Compila', inicio: s(12), emFundo: true }, 10)
  expect(atencoes(modelo([fundo])).avisos).toHaveLength(1)
  const agente = falhou({ id: 'a1', tipo: 'agy', rotulo: 'Assistente Gemini', inicio: s(12) }, 10)
  expect(atencoes(modelo([agente])).avisos[0]?.titulo).toBe('Assistente Gemini falhou')
})

test('atenção: falha dispensada (vistos) some', () => {
  const f = falhou({ id: 'a1', tipo: 'subagente', rotulo: 'Explore', inicio: s(100) }, 10)
  expect(atencoes(modelo([f])).avisos).toHaveLength(1)
  expect(atencoes(modelo([f], { vistos: ['a1'] })).avisos).toHaveLength(0)
})

test('atenção: calado > 90 s vira aviso (89 s não); > 5 min vira pendência, não os dois', () => {
  const cx = (seg: number) => trab({ id: 'cx', tipo: 'codex', rotulo: 'Revisor Codex', ultimoSinal: s(seg) })
  const com = (seg: number) => modelo([cx(seg)])
  expect(atencoes(com(89)).avisos).toEqual([])
  const calada = atencoes(com(100))
  expect(calada.pendencias).toEqual([])
  expect(calada.avisos).toHaveLength(1)
  expect(calada.avisos[0]).toMatchObject({ id: 'calado:cx', tipo: 'calado', titulo: 'Revisor Codex sem sinal há 1 min', quem: 'cx', acoes: ['esperar', 'parar'] })
  const travada = atencoes(com(372))
  expect(travada.avisos).toEqual([])
  expect(travada.pendencias).toHaveLength(1)
  expect(travada.pendencias[0]).toMatchObject({ id: 'travado:cx', nivel: 'pendencia', tipo: 'travado', titulo: 'Revisor Codex sem sinal há 6 min', quem: 'cx', acoes: ['parar', 'esperar'] })
  expect(atencoes(modelo([cx(372)], { vistos: ['travado:cx'] })).pendencias).toEqual([]) // "Esperar" esconde
  expect(calado(trab({ id: 'z', tipo: 'codex', ultimoSinal: s(30) }), AGORA)).toBe(30_000)
  expect(calado(feito({ id: 'z', tipo: 'codex' }, 300), AGORA)).toBe(0)
})

test('atenção: quem só espera filhos ativos, comando à espera de permissão e pergunta não ficam "calados"', () => {
  const pai = trab({ id: 'wf1', tipo: 'workflow', rotulo: 'meu_fluxo', ultimoSinal: s(400) })
  const filho = trab({ id: 'ag:1', tipo: 'agente-wf', pai: 'wf1', rotulo: 'x', ultimoSinal: s(5) })
  expect(atencoes(modelo([pai, filho]))).toEqual({ pendencias: [], avisos: [], maisPendencias: 0, maisAvisos: 0 })
  const cmd = trab({ id: 'c1', tipo: 'comando', rotulo: 'Instala', ultimoSinal: s(400) })
  const comPermissao = atencoes(modelo([cmd], { pendentes: { p1: pend({ id: 'p1', tipo: 'permissao', titulo: 'Permissão para rodar: Instala', quem: 'c1' }) } }))
  expect(comPermissao.pendencias.map(a => a.tipo)).toEqual(['permissao'])
  const pergunta = trab({ id: 'q1', tipo: 'pergunta', rotulo: 'Qual material?', ultimoSinal: s(900) })
  expect(atencoes(modelo([pergunta])).pendencias).toEqual([])
})

test('atenção: contexto 82% vira aviso com o texto exato; 79% não', () => {
  const a = atencoes(modelo([], { uso: { contextoPct: 82 } })).avisos
  expect(a).toHaveLength(1)
  expect(a[0]).toMatchObject({ tipo: 'contexto', nivel: 'aviso', titulo: 'Contexto em 82% · a conversa será resumida em breve', acoes: ['dispensar'] })
  expect(atencoes(modelo([], { uso: { contextoPct: 79 } })).avisos).toEqual([])
  expect(LIMITES.contexto).toBe(80)
  expect(atencoes(modelo([], { uso: { contextoPct: 82 }, vistos: ['contexto:80'] })).avisos).toEqual([])
  expect(atencoes(modelo([], { uso: { contextoPct: 91 }, vistos: ['contexto:80'] })).avisos).toHaveLength(1) // volta ao passar de faixa
})

test('atenção: cota ≥ 80% avisa com a hora de renovar; abaixo disso, nada', () => {
  const uso = { cota5h: 85, renova5h: new Date(2026, 9, 8, 19, 20).toISOString(), semana: 6, renovaSemana: new Date(2026, 9, 12, 9, 0).toISOString() }
  expect(atencoes(modelo([], { uso })).avisos.map(a => a.titulo)).toEqual(['Cota de 5h em 85% · renova às 19:20'])
  const semana = atencoes(modelo([], { uso: { ...uso, cota5h: 10, semana: 91 } })).avisos
  expect(semana.map(a => a.titulo)).toEqual(['Cota de 7 dias em 91% · renova seg 09:00'])
})

test('atenção: máximo 3 + "mais N", ordenadas por gravidade e depois por idade', () => {
  const falhas = [1, 2, 3, 4].map(i => falhou({ id: `f${i}`, tipo: 'subagente', rotulo: 'Explore', inicio: s(500) }, 100 - i)) // f1 é a mais antiga
  const m = modelo(falhas, { uso: { contextoPct: 90, cota5h: 95 } })
  const a = atencoes(m)
  expect(a.avisos).toHaveLength(3)
  expect(a.maisAvisos).toBe(3) // 4 falhas + contexto + cota = 6
  expect(a.avisos.map(x => x.id)).toEqual(['f1', 'f2', 'f3'])
  const pendentes = Object.fromEntries([1, 2, 3, 4, 5].map(i => [`p${i}`, pend({ id: `p${i}`, tipo: 'permissao', titulo: `Permissão ${i}`, desde: s(100 - i) })]))
  const b = atencoes(modelo([], { pendentes }))
  expect(b.pendencias.map(x => x.titulo)).toEqual(['Permissão 1', 'Permissão 2', 'Permissão 3'])
  expect(b.maisPendencias).toBe(2)
})

test('atenção: pendência de outra sessão aparece como "Sessão <nome>: <pendência>"; a própria não repassa a alheia', () => {
  const m = modelo([], {
    pendentes: { p1: pend({ id: 'p1', tipo: 'permissao', titulo: 'Permissão para rodar: apagar a pasta build' }) },
    sessoes: [
      { id: 's2', nome: 'Painel', nivel: 'pendencia', frentes: 2, pendencias: ['Permissão para rodar: instalar pacote'], t: AGORA },
      { id: 's3', nome: 'Caso', nivel: 'andando', frentes: 1, pendencias: [], t: AGORA },
    ],
  })
  const a = atencoes(m).pendencias
  expect(a.map(x => [x.tipo, x.titulo])).toEqual([
    ['permissao', 'Permissão para rodar: apagar a pasta build'],
    ['sessao', 'Sessão Painel: Permissão para rodar: instalar pacote'],
  ])
  expect(resumoSessao(m, 'eu', 'Painel novo').pendencias).toEqual(['Permissão para rodar: apagar a pasta build'])
})

test('atenção: falha de API tem "Dispensar" e some quando dispensada; permissão e pergunta só observam', () => {
  const m = modelo([], {
    pendentes: {
      p1: pend({ id: 'p1', tipo: 'falha-api', titulo: 'API sobrecarregada (overloaded)' }),
      p2: pend({ id: 'p2', tipo: 'permissao', titulo: 'Permissão para rodar: x' }),
    },
  })
  const a = atencoes(m).pendencias
  expect(a.map(x => [x.tipo, x.acoes])).toEqual([['permissao', []], ['falha-api', ['dispensar']]])
  expect(atencoes({ ...m, vistos: ['p1'] }).pendencias.map(x => x.tipo)).toEqual(['permissao'])
})

// ---------- árvore ----------

test('árvore: rodando primeiro, concluído recente fica, concluído antigo vira "+N prontos"', () => {
  const m = modelo([
    trab({ id: 'wf1', tipo: 'workflow', rotulo: 'meu_fluxo' }),
    feito({ id: 'ag:d', tipo: 'agente-wf', pai: 'wf1', rotulo: 'agente_d', inicio: s(100) }, 3),
    trab({ id: 'ag:a', tipo: 'agente-wf', pai: 'wf1', rotulo: 'face_branca', inicio: s(50) }),
    trab({ id: 'ag:b', tipo: 'agente-wf', pai: 'wf1', rotulo: 'face_branca', inicio: s(40) }),
    feito({ id: 'ag:c', tipo: 'agente-wf', pai: 'wf1', rotulo: 'agente_c', inicio: s(100) }, 30),
  ])
  expect(texto(arvore(m))).toEqual(['Meu fluxo', '  Face branca #1', '  Face branca #2', '  Agente d', '  +1 pronto'])
})

test('árvore: filhos de trabalhador recolhido não aparecem; pai concluído com filho rodando fica', () => {
  const m = modelo([
    feito({ id: 'a', tipo: 'subagente', rotulo: 'Explore', inicio: s(200) }, 60),
    feito({ id: 'a1', tipo: 'comando', pai: 'a', rotulo: 'Lista a pasta', inicio: s(100) }, 70),
    feito({ id: 'b', tipo: 'subagente', rotulo: 'Plan', inicio: s(200) }, 60),
    trab({ id: 'b1', tipo: 'agy', pai: 'b', rotulo: 'Assistente Gemini', modelo: 'Gemini 3.8 Flash' }),
  ])
  expect(texto(arvore(m))).toEqual(['Planejamento', '  Assistente Gemini', '+1 pronto'])
})

test('árvore: falha não vista fica como linha própria; vista vira "+N com falha"; comando curto falho vira "+N prontos"', () => {
  const ts = [
    falhou({ id: 'a', tipo: 'subagente', rotulo: 'Explore', inicio: s(300) }, 120),
    falhou({ id: 'c', tipo: 'comando', rotulo: 'Procura um texto', inicio: s(121) }, 120),
  ]
  expect(texto(arvore(modelo(ts)))).toEqual(['Pesquisa', '+1 pronto'])
  expect(texto(arvore(modelo(ts, { vistos: ['a'] })))).toEqual(['+1 com falha', '+1 pronto'])
})

test('árvore: pai desconhecido vira raiz; ciclo no estado não derruba nem trava', () => {
  const m = modelo([
    trab({ id: 'x', tipo: 'subagente', pai: 'y', rotulo: 'Explore' }),
    trab({ id: 'y', tipo: 'subagente', pai: 'x', rotulo: 'Plan' }),
    trab({ id: 'z', tipo: 'subagente', pai: 'nao-existe', rotulo: 'general-purpose' }),
  ])
  expect(texto(arvore(m))).toEqual(['Assistente'])
})

test('árvore no pior caso (20 agentes + agy aninhado + Codex + comando que falhou): ≤ 8 linhas de trabalhador', () => {
  const ags = Array.from({ length: 20 }, (_, i) => {
    const n = i + 1
    const o = { id: `ag:${n}`, tipo: 'agente-wf' as const, pai: 'wf1', rotulo: `agente_${n}`, inicio: s(600 - n) }
    return n <= 7 ? feito(o, 60) : trab({ ...o, ultimoSinal: s(5) })
  })
  const m = modelo(
    [
      trab({ id: 'wf1', tipo: 'workflow', rotulo: 'painel-vivo-v2-implementa', inicio: s(700) }),
      ...ags,
      trab({ id: 'agy1', tipo: 'agy', pai: 'ag:15', rotulo: 'Assistente Gemini', modelo: 'Gemini 3.8 Flash (High)', inicio: s(190), ultimoSinal: s(2) }),
      trab({ id: 'sub1', tipo: 'subagente', rotulo: 'Explore', inicio: s(400), ultimoSinal: s(2) }),
      trab({ id: 'sub2', tipo: 'subagente', rotulo: 'Explore', inicio: s(300), ultimoSinal: s(2) }),
      trab({ id: 'cx', tipo: 'codex', rotulo: 'Revisor Codex', inicio: s(900), ultimoSinal: s(10) }),
      falhou({ id: 'cmd', tipo: 'comando', rotulo: 'Fatia o modelo', inicio: s(300) }, 100),
    ],
    { workflows: doFluxo, principal: princ({ ocupado: true }), uso: { contextoPct: 82 } },
  )
  const ls = arvore(m)
  expect(raias(ls)).toBeLessThanOrEqual(LIMITES.raias)

  // agy logo abaixo do agente que o chamou, um nível adiante
  const i = ls.findIndex(l => l.tipo === 'trabalhador' && l.t.id === 'agy1')
  expect(i).toBeGreaterThan(0)
  const pai = ls[i - 1]
  const filho = ls[i]
  expect(pai?.tipo === 'trabalhador' && pai.t.id).toBe('ag:15')
  expect(filho?.nivel).toBe((pai?.nivel ?? 0) + 1)

  // o que não pode ficar no escuro aparece: Codex, falha e os dois subagentes com ordinais #1/#2
  const nomes = texto(ls)
  expect(nomes).toContain('Revisor Codex')
  expect(nomes).toContain('Comando: Fatia o modelo')
  expect(nomes).toContain('Pesquisa #1')
  expect(nomes).toContain('Pesquisa #2')

  // o resto do workflow vira contagem sob o próprio workflow, sem perder ninguém
  const wf = ls.findIndex(l => l.tipo === 'trabalhador' && l.t.id === 'wf1')
  expect(wf).toBeGreaterThanOrEqual(0)
  const resumos = ls.filter((l): l is Extract<Linha, { tipo: 'resumo' }> => l.tipo === 'resumo' && l.nivel === 1)
  expect(resumos.map(r => r.texto)).toEqual([`+${resumos[0]!.ids.length} em execução`, '+7 prontos'])
  const mostrados = ls.filter(l => l.tipo === 'trabalhador' && l.t.pai === 'wf1').length
  expect(mostrados + resumos.reduce((n, r) => n + r.ids.length, 0)).toBe(20)

  // veredito coerente: 12 agentes sem filho rodando + agy + 2 pesquisas + Codex = 16 frentes; avisos: falha e contexto
  const v = veredito(m)
  expect(v.nivel).toBe('aviso')
  expect(v.sub).toBe('16 frentes · 2 avisos')
  expect(v.tiles[1]?.valor).toBe('16 trabalhando')
})

test('árvore: sem ordinal quando o nome é único; ordinais só entre irmãos de mesmo pai', () => {
  const ts = [
    trab({ id: 'a', tipo: 'subagente', rotulo: 'Explore', inicio: s(30) }),
    trab({ id: 'b', tipo: 'subagente', rotulo: 'Explore', inicio: s(20) }),
    trab({ id: 'c', tipo: 'subagente', rotulo: 'Plan', inicio: s(10) }),
    trab({ id: 'd', tipo: 'subagente', pai: 'c', rotulo: 'Explore', inicio: s(5) }),
  ]
  expect([...ordinais(ts)]).toEqual([['a', 1], ['b', 2]])
})

// ---------- nomes humanos ----------

test('nomes humanos por tipo', () => {
  const n = (t: Partial<Trabalhador> & Pick<Trabalhador, 'tipo'>) => nomeHumano(trab({ id: 'x', ...t }))
  expect(n({ tipo: 'subagente', rotulo: 'Explore' })).toBe('Pesquisa')
  expect(n({ tipo: 'subagente', rotulo: 'Plan' })).toBe('Planejamento')
  expect(n({ tipo: 'subagente', rotulo: 'general-purpose' })).toBe('Assistente')
  expect(n({ tipo: 'subagente', rotulo: 'codex:codex-rescue' })).toBe('Revisor Codex')
  expect(n({ tipo: 'subagente', rotulo: 'claude-code-guide' })).toBe('Consulta')
  expect(n({ tipo: 'subagente', rotulo: 'superpowers:code-reviewer' })).toBe('Code reviewer')
  expect(n({ tipo: 'subagente', rotulo: '' })).toBe('Assistente')
  expect(n({ tipo: 'agente-wf', rotulo: 'face_branca' })).toBe('Face branca')
  expect(n({ tipo: 'agente-wf', rotulo: 'conceito-gemini' })).toBe('Conceito gemini')
  expect(n({ tipo: 'comando', rotulo: 'Fatia o modelo' })).toBe('Comando: Fatia o modelo')
  expect(n({ tipo: 'comando', rotulo: '' })).toBe('Comando')
  expect(n({ tipo: 'agy', rotulo: 'Assistente Gemini Flash', modelo: 'Gemini 3.8 Flash (High)' })).toBe('Assistente Gemini')
  expect(n({ tipo: 'agy', modelo: 'Claude Sonnet 4.6 (Thinking)' })).toBe('Assistente Claude')
  expect(n({ tipo: 'codex', rotulo: 'codex-companion' })).toBe('Revisor Codex')
  expect(n({ tipo: 'workflow', rotulo: 'painel-vivo-v2-implementa' })).toBe('Painel vivo v2 implementa')
  expect(n({ tipo: 'workflow', rotulo: 'C:/projetos/meu_fluxo.js' })).toBe('Meu fluxo') // título que veio como caminho
  expect(n({ tipo: 'workflow', rotulo: 'Conserto da plataforma 3D' })).toBe('Conserto da plataforma 3D')
  expect(n({ tipo: 'pergunta', rotulo: 'Qual material?' })).toBe('Pergunta ao usuário')
  expect(n({ tipo: 'comando', rotulo: 'x'.repeat(100) }).length).toBeLessThanOrEqual(56)
})

// ---------- tempo, números, hora ----------

test('tempo: 45s, 2 min, 7min 47s, 12 min, 1h 05min', () => {
  expect(tempo(0)).toBe('0s')
  expect(tempo(45_000)).toBe('45s')
  expect(tempo(120_000)).toBe('2 min')
  expect(tempo(467_000)).toBe('7min 47s')
  expect(tempo(720_000)).toBe('12 min')
  expect(tempo(3_900_000)).toBe('1h 05min')
  expect(tempo(-5)).toBe('0s')
})

test('mil: "260 mil", "8,4 mi"', () => {
  expect(mil(500)).toBe('500')
  expect(mil(260_000)).toBe('260 mil')
  expect(mil(8_400_000)).toBe('8,4 mi')
  expect(mil(1_000_000)).toBe('1 mi')
  expect(mil(999_700)).toBe('1 mi')
})

test('horaCurta: hoje só a hora; outro dia com o dia da semana; aceita ISO e número', () => {
  expect(horaCurta(new Date(2026, 9, 8, 19, 20).getTime(), AGORA)).toBe('19:20')
  expect(horaCurta(new Date(2026, 9, 8, 9, 5).toISOString(), AGORA)).toBe('09:05')
  expect(horaCurta(new Date(2026, 9, 12, 9, 0).toISOString(), AGORA)).toBe('seg 09:00')
  expect(horaCurta('lixo', AGORA)).toBe('')
})

// ---------- o que o agente faz ----------

test('traduzirPassoAgy: passos do agy em português simples, sem caminho completo', () => {
  expect(traduzirPassoAgy('view_file: main.py')).toBe('lendo main.py')
  expect(traduzirPassoAgy('view_file: C:/projeto/src/main.py')).toBe('lendo main.py')
  expect(traduzirPassoAgy('view_file')).toBe('lendo um arquivo')
  expect(traduzirPassoAgy('run_command: python run.py --x 1')).toBe('rodando um comando')
  expect(traduzirPassoAgy('write_to_file: /a/b/notas.md')).toBe('escrevendo notas.md')
  expect(traduzirPassoAgy('replace_file_content: /a/b/notas.md')).toBe('editando notas.md')
  expect(traduzirPassoAgy('grep_search: foo')).toBe('procurando nos arquivos')
  expect(traduzirPassoAgy('list_dir: /a/b')).toBe('listando a pasta')
  expect(traduzirPassoAgy('search_web: preço do filamento')).toBe('pesquisando na internet')
  expect(traduzirPassoAgy('pensando')).toBe('pensando')
  expect(traduzirPassoAgy('escrevendo a resposta')).toBe('escrevendo a resposta')
  expect(traduzirPassoAgy('ferramenta_nova: x')).toBe('usando ferramenta nova')
  expect(traduzirPassoAgy('concluído')).toBe('concluído')
})

test('acaoDe: ferramenta + entrada → tipo e texto simples, sem caminho completo', () => {
  expect(acaoDe('Read', { file_path: 'C:\\projetos\\3D\\corners.png' })).toEqual({ tipo: 'leitura', texto: 'lendo corners.png' })
  expect(acaoDe('Read', {})).toEqual({ tipo: 'leitura', texto: 'lendo um arquivo' })
  expect(acaoDe('Edit', { file_path: '/a/b/regras.ts' })).toEqual({ tipo: 'edicao', texto: 'editando regras.ts' })
  expect(acaoDe('Write', { file_path: '/a/b/regras.ts' })).toEqual({ tipo: 'edicao', texto: 'escrevendo regras.ts' })
  expect(acaoDe('Grep', { pattern: 'foo' })).toEqual({ tipo: 'busca', texto: 'procurando nos arquivos' })
  expect(acaoDe('Glob', { pattern: '**/*.ts' })).toEqual({ tipo: 'busca', texto: 'listando arquivos' })
  expect(acaoDe('Bash', { command: 'ls' })).toEqual({ tipo: 'comando', texto: 'rodando um comando' })
  expect(acaoDe('Bash', { command: 'ls', description: 'Lista a pasta' })).toEqual({ tipo: 'comando', texto: 'Lista a pasta' })
  expect(acaoDe('WebSearch', { query: 'x' })).toEqual({ tipo: 'web', texto: 'pesquisando na internet' })
  expect(acaoDe('Agent', { description: 'Pesquisa de materiais' })).toEqual({ tipo: 'agente', texto: 'chamando um ajudante · Pesquisa de materiais' })
  expect(acaoDe('TodoWrite', {})).toEqual({ tipo: 'outro', texto: 'atualizando o plano' })
  expect(acaoDe('mcp__blender__x', {})).toEqual({ tipo: 'outro', texto: 'usando uma ferramenta externa' })
  expect(acaoDe('Coisa', undefined)).toEqual({ tipo: 'outro', texto: 'usando Coisa' })
})

// ---------- resumo da sessão ----------

test('resumoSessao: pendência > andando > ocioso, com a hora do modelo', () => {
  const ociosa = resumoSessao(modelo(), 's1', 'Painel')
  expect(ociosa).toEqual({ id: 's1', nome: 'Painel', nivel: 'ocioso', frentes: 0, pendencias: [], t: AGORA })
  const andando = resumoSessao(modeloAndando(), 's1', 'Painel')
  expect(andando).toMatchObject({ nivel: 'andando', frentes: 4, pendencias: [] })
  const comPendencia = resumoSessao(modeloAndando([], { pendentes: { p: pend({ id: 'p', tipo: 'pergunta', titulo: 'Qual material usar?' }) } }), 's1', 'Painel')
  expect(comPendencia).toMatchObject({ nivel: 'pendencia', frentes: 4, pendencias: ['Qual material usar?'] })
})

// Modelo e tokens à vista na raia (pedido do usuário 08/10: não precisar abrir o painel do app).
test('modeloCurto: nomes do Claude, do Gemini e outros', () => {
  expect(modeloCurto('claude-sonnet-5-5')).toBe('Sonnet 5.5')
  expect(modeloCurto('claude-opus-5')).toBe('Opus 5')
  expect(modeloCurto('Gemini 3.8 Flash (High)')).toBe('Gemini 3.8 Flash')
  expect(modeloCurto('gpt-5.4')).toBe('gpt-5.4')
})

test('quemGasta: Claude com modelo e tokens; Codex sem tokens; workflow soma os agentes; comando nada', () => {
  const ag = { id: 'ag:1', tipo: 'agente-wf', pai: 'wf', rotulo: 'x', agora: '', inicio: 0, situacao: 'rodando', ultimoSinal: 0, acoes: [], modelo: 'claude-sonnet-5-5', tokensNovos: 1_000, tokensCache: 70_000 } as Trabalhador
  expect(quemGasta(ag)).toBe('Sonnet 5.5 · 71 mil tokens')
  expect(quemGasta({ ...ag, tipo: 'codex', modelo: undefined })).toBe('modelo padrão')
  expect(quemGasta({ ...ag, tipo: 'agy', modelo: 'Gemini 3.8 Flash (High)', tokensNovos: 40_101, tokensCache: 0 })).toBe('Gemini 3.8 Flash · 40 mil tokens')
  expect(quemGasta({ ...ag, id: 'wf', tipo: 'workflow', modelo: undefined }, [ag, { ...ag, id: 'ag:2' }])).toBe('142 mil tokens')
  expect(quemGasta({ ...ag, tipo: 'comando' })).toBe('')
})

test('somaTokensAgy: o último passo traz o acumulado e não soma de novo (arquivo real de 08/10)', () => {
  expect(somaTokensAgy([14963, 19589, 5549, 40101])).toBe(40101)
  expect(somaTokensAgy([14963, 19589])).toBe(34552)
  expect(somaTokensAgy([])).toBe(0)
})

// Decisão do usuário (08/10): a cota lembra de novo ao subir de 80% para 90% (e 100%); nunca repete dentro da faixa;
// e cada janela nova da cota (outra hora de renovação) avisa de novo.
test('cota: dispensado aos 80% não volta aos 88%, volta aos 90%, e volta na janela seguinte', () => {
  const janela1 = new Date(2026, 9, 8, 19, 20).toISOString()
  const janela2 = new Date(2026, 9, 9, 0, 20).toISOString()
  const aviso = (cota5h: number, renova5h: string, vistos: string[] = []) => atencoes(modelo([], { uso: { cota5h, renova5h }, vistos })).avisos
  const visto80 = aviso(82, janela1).map(a => a.id)
  expect(visto80.length).toBe(1)
  expect(aviso(88, janela1, visto80)).toEqual([])
  expect(aviso(91, janela1, visto80).map(a => a.titulo)).toEqual(['Cota de 5h em 91% · renova às 19:20'])
  expect(aviso(81, janela2, visto80).length).toBe(1)
})

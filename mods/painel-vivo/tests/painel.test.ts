import { expect, mock, test } from 'claude-code/testing'

import type { Trabalhador } from '../types'

// Monta o painel no desktop e no terminal com um estado rico gravado nos atoms antes do desenho.
const PLUGIN = 'painel-vivo'
const AGORA = Date.UTC(2026, 9, 8, 18, 0, 0)
const MIN = 60_000
const PROIBIDAS = ['Merece um olho', 'Nada precisa de você', 'Preciso fazer algo', 'Nada te bloqueia', 'esforço', 'Memória da conversa', '!']
const PANE = { title: 'Painel', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } as const
const VIEWPORT = { columns: 100, rows: 60, isFullscreen: true }

function trab(id: string, tipo: Trabalhador['tipo'], pai: string, rotulo: string, extra: Partial<Trabalhador> = {}): Trabalhador {
  return { id, tipo, pai, rotulo, agora: 'pensando', inicio: AGORA - 10 * MIN, situacao: 'rodando', ultimoSinal: AGORA - 2000, acoes: [], ...extra }
}

const feito = (id: string, pai: string, rotulo: string) =>
  trab(id, 'agente-wf', pai, rotulo, { situacao: 'feito', fim: AGORA - MIN, ultimoSinal: AGORA - MIN, modelo: 'claude-sonnet-5' })

// Workflow com agentes (um com agy aninhado, cinco prontos, um que falhou), Codex travado, comando com %.
const TRABALHADORES: Record<string, Trabalhador> = Object.fromEntries(
  [
    trab('wf1', 'workflow', 'principal', 'conserto-plataforma', { ultimoSinal: AGORA - 4 * MIN, agora: 'coordenando os agentes' }),
    trab('ag:a1', 'agente-wf', 'wf1', 'face_branca', { ultimoSinal: AGORA - 3 * MIN, agentId: 'a1', modelo: 'claude-opus-5', tokensNovos: 260_000, tokensCache: 8_400_000 }),
    trab('agy1', 'agy', 'ag:a1', 'python run_agy.py', { agora: 'lendo corners.png', passos: 7, modelo: 'Gemini 3.8 Flash', inicio: AGORA - 2 * MIN, acoes: [{ t: AGORA - 30_000, tipo: 'leitura', texto: 'lendo corners.png' }] }),
    feito('ag:a2', 'wf1', 'projetista_grade'),
    feito('ag:a3', 'wf1', 'projetista_grade'),
    feito('ag:a4', 'wf1', 'analista_cantos'),
    feito('ag:a5', 'wf1', 'analista_cantos'),
    feito('ag:a6', 'wf1', 'revisor_final'),
    trab('ag:a7', 'agente-wf', 'wf1', 'pesquisador_material', { situacao: 'falhou', fim: AGORA - 30_000, ultimoSinal: AGORA - 30_000, acoes: [{ t: AGORA - 30_000, tipo: 'comando', texto: 'rodando um comando', erro: true }] }),
    trab('codex1', 'codex', 'principal', 'codex-companion review', { ultimoSinal: AGORA - 6 * MIN, agora: 'conferindo a última edição' }),
    trab('cmd1', 'comando', 'principal', 'Fatia o modelo', { pct: 63, inicio: AGORA - 4 * MIN, agora: 'cortando o modelo em camadas', cauda: ['\x1b[32mcamada 120/190\x1b[0m', '63%'] }),
  ].map(t => [t.id, t]),
)

const ACOES = Array.from({ length: 40 }, (_, i) => ({ t: AGORA - i * 50_000, tipo: (['leitura', 'busca', 'edicao', 'comando'] as const)[i % 4], texto: `ação ${i}` }))

const CHEIO = {
  trabalhadores: TRABALHADORES,
  workflows: { wf1: { id: 'wf1', nome: 'conserto-plataforma', desc: 'Conserto da plataforma 3D', fases: [{ titulo: 'Investigar' }, { titulo: 'Propor' }], fasePorAgente: {} } },
  pendentes: { perm1: { id: 'perm1', tipo: 'permissao', titulo: 'Permissão para rodar: apagar a pasta build', quem: 'principal', desde: AGORA - MIN } },
  vistos: [],
  uso: { contextoPct: 82, cota5h: 11, renova5h: new Date(AGORA + 80 * MIN).toISOString(), semana: 6, renovaSemana: new Date(AGORA + 3 * 24 * 60 * MIN).toISOString() },
  principal: { ocupado: true, ultimoSinal: AGORA - 2000, plano: { feitos: 2, total: 7, atual: 'Testando a grade' }, tokensNovos: 120_000, tokensCache: 2_000_000, acoes: ACOES, titulo: 'conserto da plataforma 3D' },
  sessoes: [
    { id: 's2', nome: 'Relatório', nivel: 'pendencia', frentes: 1, pendencias: ['Permissão para rodar: gerar o PDF'], t: AGORA - 10_000 },
    { id: 's3', nome: 'Fatiador', nivel: 'andando', frentes: 2, pendencias: [], t: AGORA - 5000 },
  ],
  relogio: AGORA,
  aberto: 'cmd1',
  historicoAberto: true,
  sessoesAbertas: true,
  verGlossario: false,
  glossario: [],
}

const OCIOSO = {
  ...CHEIO,
  trabalhadores: {},
  workflows: {},
  pendentes: {},
  uso: { cota5h: 11, semana: 6 },
  principal: { ocupado: false, ultimoSinal: AGORA - 5 * MIN, fimTurno: AGORA - 5 * MIN, tokensNovos: 0, tokensCache: 0, acoes: [] },
  sessoes: [],
  aberto: '',
  historicoAberto: false,
  sessoesAbertas: false,
}

// Pior caso: 20 agentes rodando no workflow, mais pendência, aviso e outras sessões.
const PIOR = {
  ...CHEIO,
  trabalhadores: {
    ...TRABALHADORES,
    ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`ag:x${i}`, trab(`ag:x${i}`, 'agente-wf', 'wf1', `agente_${i}`, { inicio: AGORA - i * 1000 })])),
  },
  aberto: '',
}

// O $ do teste não tem `state`: os atoms do plugin são semeados por ganchos de teste, que ficam abaixo dele.
// A leitura passa pelo kit (assina o redesenho) e troca o valor; a escrita anota e segue para o kit.
// O gancho vê a resposta embrulhada: { value: { value, version } }.
async function montar($: any, on: any, estado: Record<string, unknown>, surface: 'desktop' | 'terminal') {
  const valores: Record<string, unknown> = { ...estado }
  on('state.get', async (_: any, e: any, next: any) => {
    const lido = await next(e)
    if (e.plugin !== PLUGIN || !(e.key in valores) || !lido?.value) return lido
    return { value: { ...lido.value, value: valores[e.key] } }
  })
  on('state.set', async (_: any, e: any, next: any) => {
    if (e.plugin === PLUGIN) valores[e.key] = e.value
    return next(e)
  })
  mock.clock(on, { now: AGORA })
  mock.store(on)
  mock.env(on, {})
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PANE, viewport: VIEWPORT })
}

function semProibidas(tudo: string) {
  for (const f of PROIBIDAS) expect(tudo.includes(f), `frase proibida no painel: ${f}`).toBe(false)
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`painel cheio · ${surface}`, async ($, on) => {
    const ui = await montar($, on, CHEIO, surface)
    const tudo = JSON.stringify(await ui.drawn())
    semProibidas(tudo)

    expect(await ui.find({ type: 'Text', text: /^Pendências · \d+$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Avisos · \d+$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Em execução' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\+5 prontos/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /2 outras sessões · 1 pendência/ })).toBeDefined()

    // agy chamado pelo agente de workflow aparece com nome humano, logo depois do agente que o chamou.
    const botoes = (await ui.findAll({ type: 'Button' })).map((b: any) => b.key ?? '')
    expect((await ui.find({ type: 'Button', key: 'abrir:agy1' }))?.text).toContain('Assistente Gemini')
    expect(botoes.indexOf('abrir:agy1')).toBe(botoes.indexOf('abrir:ag:a1') + 1)

    // Botões da pendência travada e do aviso de falha, com keys próprias.
    expect(botoes).toContain('pend:parar:travado:codex1')
    expect(botoes).toContain('aviso:explicar:ag:a7')
    expect(new Set(botoes).size).toBe(botoes.length)

    // Detalhe aberto: cauda sem códigos de cor.
    const cauda = await ui.find({ type: 'Code', text: /camada 120\/190/ })
    expect(cauda?.text.includes('\x1b')).toBe(false)

    // Sem esforço, modelo ou contexto no rodapé: "Uso" só com as cotas.
    expect(await ui.find({ type: 'Text', text: 'Uso' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^11% · renova às/ })).toBeDefined()

    // SVG só onde a superfície desenha.
    const svgs = await ui.findAll({ type: 'Svg' })
    if (surface === 'terminal') expect(svgs).toHaveLength(0)
    else expect(svgs.length).toBeGreaterThan(3)

    // Relógio do comando conta sozinho, sem redesenho do painel.
    const antes = (await ui.find({ in: 'tempo:cmd1', type: 'Text' }))?.text
    expect(antes).toBe('4 min')
    await ui.advance(3000)
    expect((await ui.find({ in: 'tempo:cmd1', type: 'Text' }))?.text).toBe('4min 3s')

    // Histórico aberto lista os concluídos; o botão fecha.
    expect(await ui.find({ type: 'Button', key: 'hist:ag:a2' })).toBeDefined()
    await ui.press({ key: 'historico' })
    expect(await ui.find({ type: 'Button', key: 'hist:ag:a2' })).toBeUndefined()
  })

  test(`painel ocioso · ${surface}`, async ($, on) => {
    const ui = await montar($, on, OCIOSO, surface)
    const tudo = JSON.stringify(await ui.drawn())
    semProibidas(tudo)
    expect(tudo).toContain('Concluído')
    expect(tudo).toContain('ocioso desde')
    expect(await ui.find({ type: 'Text', text: 'Em execução' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Pendências · / })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Uso' })).toBeDefined()
  })

  test(`pior caso · ${surface}`, async ($, on) => {
    const ui = await montar($, on, PIOR, surface)
    semProibidas(JSON.stringify(await ui.drawn()))
    const raias = (await ui.findAll({ type: 'Button' })).filter((b: any) => (b.key ?? '').startsWith('abrir:'))
    expect(raias.length).toBeLessThanOrEqual(8)
    expect(await ui.find({ type: 'Text', text: /em execução$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Pendências · \d+$/ })).toBeDefined()
  })
}

// Botões dos avisos: UM clique basta (relato do usuário 08/10: Dispensar pedia vários cliques; Explicar "não funcionava").
test('Dispensar some com um clique; Explicar mostra o resultado no próprio cartão', async ($, on) => {
  on('model.complete', async () => ({ value: { isAnswered: true, text: '{"explicacao": "**O que faz** testa o painel.", "termos": []}', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  const ui = await montar($, on, { ...CHEIO, uso: { ...CHEIO.uso, cota5h: 88 }, aberto: '' }, 'desktop')
  const botoes = async () => (await ui.findAll({ type: 'Button' })).map((b: any) => b.key ?? '')

  const cota = (await botoes()).find((k: string) => k.startsWith('aviso:dispensar:cota5h'))
  expect(cota).toBeDefined()
  await ui.press({ key: cota! })
  expect((await botoes()).includes(cota!)).toBe(false)

  await ui.press({ key: 'aviso:explicar:ag:a7' })
  expect(await ui.find({ type: 'Markdown', text: /testa o painel/ })).toBeDefined()
  expect((await botoes()).includes('aviso:explicar:ag:a7')).toBe(false)
})

// Outras sessões: só as que trabalham ou têm pendência (pedido do usuário 08/10); sessão parada não aparece.
const PARADA = { id: 's9', nome: 'Calibração PETG', nivel: 'ocioso', frentes: 0, pendencias: [], t: AGORA - 5000 }

test('outras sessões: só paradas → a linha nem aparece', async ($, on) => {
  const ui = await montar($, on, { ...CHEIO, sessoes: [PARADA], sessoesAbertas: true }, 'desktop')
  expect(await ui.find({ type: 'Button', key: 'sessoes' })).toBeUndefined()
})

test('outras sessões: parada some; trabalhando sem ajudantes diz "Claude trabalhando"', async ($, on) => {
  const ui = await montar($, on, { ...CHEIO, sessoes: [PARADA, { ...PARADA, id: 's8', nome: 'Relatório', nivel: 'andando' }], sessoesAbertas: true }, 'desktop')
  expect((await ui.find({ type: 'Button', key: 'sessoes' }))?.text).toContain('1 outra sessão · em andamento')
  expect(await ui.find({ type: 'Text', text: /Relatório · Claude trabalhando/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Calibração PETG/ })).toBeUndefined()
})

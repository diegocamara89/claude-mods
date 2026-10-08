import type { Acao, Acoes, Atencao, Linha, Modelo, ResumoSessao, Trabalhador } from '../types'
import { LIMITES, arvore, atencoes, calado, horaCurta, mil, modeloCurto, nomeHumano, quemGasta, tempo, veredito } from './regras'
import { PALETA as P, barraUso, faixa, fita, semSinal, titulo } from './svg'

// Árvore de elementos do painel. Só lê o modelo (nunca grava); botões chamam `acoes` (ações de coleta.ts).
// Não recebe o $: o motor só segue o $ para funções do próprio hooks module, nunca através de import.
// Quem chama passa `$.ui.resolve(e)` e as ações já presas ao $ (ver Acoes em types/index.d.ts).
// Desktop (e demais superfícies remotas) desenha os SVGs; o terminal, que não tem Svg, recebe só texto.

// Janela das raias e da fita: do primeiro trabalho visível até agora, entre 2 e 40 min.
const janelaDe = (desde: number, agora: number) => Math.min(40 * 60_000, Math.max(2 * 60_000, (agora - desde) * 1.08))
const PX = 8 // px de SVG por célula

const COR_NIVEL = { ok: P.ok, aviso: P.aviso, pendencia: P.pendencia, neutro: P.texto }
// Largura e altura explícitas, lidas do próprio SVG: sem elas o quadro encolhe a cada redesenho e o resto pula.
const tam = (source: string) => {
  const [, w, h] = /width="([\d.]+)" height="([\d.]+)"/.exec(source) ?? []
  return { source, ...(w && h ? { width: Number(w), height: Number(h) } : {}) }
}
const ROTULO_ACAO = { explicar: 'Explicar', dispensar: 'Dispensar', parar: 'Parar', esperar: 'Esperar' }

const corDe = (t: Trabalhador) =>
  t.id === 'principal' ? P.texto
  : t.tipo === 'agy' ? P.gemini
  : t.tipo === 'codex' ? P.codex
  : t.tipo === 'comando' ? P.comando
  : t.tipo === 'pergunta' ? P.pendencia
  : P.agentes
const corta = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)
const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`
// Saída de comando pode trazer cores ANSI e \r: Code, Markdown e Text só aceitam tab e quebra de linha.
const limpo = (s: unknown) => String(s ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
const recuo = (nivel: number) => (nivel > 0 ? '  '.repeat(nivel - 1) + '└ ' : '')
const renova = (agora: number, iso?: string) => {
  if (!iso) return ''
  const h = horaCurta(iso, agora)
  return ` · renova ${/^\d/.test(h) ? 'às ' : ''}${h}`
}

// Só entram as outras sessões trabalhando ou com pendência; as paradas não aparecem (pedido do usuário 08/10).
function resumoSessoes(ss: ResumoSessao[]): string {
  const quantas = ss.length === 1 ? '1 outra sessão' : `${ss.length} outras sessões`
  const pend = ss.filter(s => s.nivel === 'pendencia').length
  return `${quantas} · ${pend ? plural(pend, 'pendência', 'pendências') : 'em andamento'}`
}

const estadoSessao = (s: ResumoSessao) =>
  s.nivel === 'pendencia' ? s.pendencias.join(' · ') || 'pendência'
  : s.nivel === 'andando' ? (s.frentes ? `em andamento · ${plural(s.frentes, 'frente', 'frentes')}` : 'Claude trabalhando')
  : 'sem atividade'

export function desenharPainel(el: any, e: any, m: Modelo, acoes: Acoes): any {
  const { Box, Text, Button, Svg, Client, Code, Markdown } = el
  const grafico = e.surface !== 'terminal'
  const larg = Math.max(30, Number(e.props?.bodyColumns ?? e.viewport?.columns ?? 80))
  const hora = (x: string | number) => horaCurta(x, m.agora)

  if (m.verGlossario) {
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color={P.texto}>Glossário</Text>
          <Button key="voltar" label="Voltar" onPress={() => void acoes.alternar('verGlossario')} />
        </Box>
        {m.glossario.length === 0 && <Text color={P.apagado}>Nenhum termo ainda.</Text>}
        {m.glossario.map(g => (
          <Text color={P.secundario}>
            <Text bold color={P.texto}>{g.termo}</Text>
            {`: ${g.definicao}`}
          </Text>
        ))}
      </Box>
    )
  }

  const v = veredito(m)
  const at = atencoes(m)
  const linhas = arvore(m)
  const ocioso = v.nivel === 'ocioso'
  const todos = Object.values(m.trabalhadores)

  // Último sinal contando os filhos que ainda rodam: quem só espera filho ativo não fica "sem sinal".
  const sinal = (t: Trabalhador, d = 0): number =>
    d > 8 ? t.ultimoSinal : Math.max(t.ultimoSinal, ...todos.filter(f => f.pai === t.id && f.situacao === 'rodando').map(f => sinal(f, d + 1)))

  // (1) Linha fina: ao vivo e glossário. As cotas ficam só em Uso (pedido do usuário: menos ênfase).
  const topo = (
    <Box flexDirection="row" justifyContent="space-between">
      <Text color={P.apagado} wrap="truncate-end">
        {ocioso
          ? `ocioso${m.principal.fimTurno ? ` desde ${hora(m.principal.fimTurno)}` : ''}`
          : <Text color={P.ok}>● <Text color={P.secundario}>ao vivo</Text></Text>}
      </Text>
      <Button plain key="glossario" label="Glossário" onPress={() => void acoes.alternar('verGlossario')} />
    </Box>
  )

  // (2) Veredito: manchete grande e os 3 números.
  const [fundo, borda, corSub] =
    v.nivel === 'pendencia' ? [P.pendenciaFundo, P.pendenciaBorda, P.pendencia]
    : v.nivel === 'aviso' ? [P.avisoFundo, P.avisoBorda, P.aviso]
    : [P.cartao, P.borda, v.nivel === 'andando' ? P.ok : P.secundario]
  const vered = (
    <Box flexDirection="column" borderStyle="round" borderColor={borda} backgroundColor={fundo} paddingX={1} gap={1}>
      {grafico
        ? <Svg {...tam(titulo(v.manchete, v.sub, P.texto, corSub, (larg - 4) * PX))} alt={`${v.manchete}. ${v.sub}`} />
        : (
          <Box flexDirection="column">
            <Text bold color={P.texto}>{v.manchete}</Text>
            {v.sub ? <Text color={corSub}>{v.sub}</Text> : null}
          </Box>
        )}
      {!ocioso && (grafico
        ? (
          <Box flexDirection="row" gap={1}>
            {v.tiles.map(t => (
              <Box flexDirection="column" flexGrow={1} flexShrink={1} width="30%" borderStyle="round" borderColor={P.borda} paddingX={1}>
                <Text color={P.secundario} wrap="truncate-end">{t.rotulo}</Text>
                <Text bold color={COR_NIVEL[t.nivel]} wrap="truncate-end">{t.valor}</Text>
                {t.detalhe ? <Text color={P.apagado} wrap="truncate-end">{t.detalhe}</Text> : null}
              </Box>
            ))}
          </Box>
        )
        : (
          <Text color={P.secundario} wrap="truncate-end">
            {v.tiles.map((t, i) => (
              <Text>
                {i ? '  ·  ' : ''}
                {`${t.rotulo} `}
                <Text bold color={COR_NIVEL[t.nivel]}>{t.valor}</Text>
              </Text>
            ))}
          </Text>
        ))}
    </Box>
  )

  // (3) Outras sessões: uma linha recolhida; o clique abre a lista.
  const ativas = m.sessoes.filter(s => s.nivel !== 'ocioso')
  const sessoes = ativas.length > 0 && (
    <Box flexDirection="column">
      <Button plain key="sessoes" label={`${m.sessoesAbertas ? '▾' : '▸'} ${resumoSessoes(ativas)}`} onPress={() => void acoes.alternar('sessoesAbertas')} />
      {m.sessoesAbertas && ativas.map(s => (
        <Text color={s.nivel === 'pendencia' ? P.pendencia : P.secundario} wrap="truncate-end">{`  ${s.nome} · ${estadoSessao(s)}`}</Text>
      ))}
    </Box>
  )

  // (4)(5) Pendências e Avisos: cartões com os botões de cada um.
  const agir = (acao: Atencao['acoes'][number], a: Atencao) =>
    acao === 'explicar' ? acoes.explicar(a.quem ?? a.id)
    : acao === 'parar' ? acoes.parar(a.quem ?? a.id)
    : acoes.dispensar(a.tipo === 'erro' && a.quem && a.quem !== a.id ? [a.id, a.quem] : [a.id]) // dispensar e esperar: marca como visto
  const cartao = (a: Atencao, pref: string) => {
    const [f, b] = a.nivel === 'pendencia' ? [P.pendenciaFundo, P.pendenciaBorda] : [P.avisoFundo, P.avisoBorda]
    // Contexto e cota não têm idade; "sem sinal há 6 min" já diz a idade no título.
    const idade = !['contexto', 'cota', 'calado', 'travado'].includes(a.tipo) && a.desde ? `há ${tempo(m.agora - a.desde)}` : ''
    // Explicar mostra o resultado aqui mesmo; depois de explicado, o botão sai.
    const quem = a.quem ? m.trabalhadores[a.quem] : undefined
    const botoes = a.acoes.filter(acao => acao !== 'explicar' || !(quem?.explicacao || quem?.explicando))
    // Botões na linha do título: o que cresce embaixo (explicação) não os empurra para longe do mouse.
    const info = [a.detalhe ? limpo(a.detalhe) : '', idade].filter(Boolean).join(' · ')
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={b} backgroundColor={f} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text bold color={P.texto} wrap="truncate-end">{limpo(a.titulo)}</Text>
          </Box>
          {botoes.length > 0 && (
            <Box flexDirection="row" gap={1} flexShrink={0}>
              {botoes.map(acao => (
                <Button key={`${pref}:${acao}:${a.id}`} label={ROTULO_ACAO[acao]} onPress={() => void agir(acao, a)} />
              ))}
            </Box>
          )}
        </Box>
        {info ? <Text color={P.secundario}>{info}</Text> : null}
        {quem?.explicando ? <Text color={P.apagado}>explicando…</Text> : null}
        {quem?.explicacao ? <Markdown text={limpo(quem.explicacao)} /> : null}
      </Box>
    )
  }
  const secao = (nome: string, itens: Atencao[], mais: number, cor: string, pref: string) =>
    itens.length > 0 && (
      <Box flexDirection="column" gap={1}>
        <Text bold color={cor}>{`${nome} · ${itens.length + mais}`}</Text>
        {itens.map(a => cartao(a, pref))}
        {mais > 0 ? <Text color={P.apagado}>{`mais ${mais}`}</Text> : null}
      </Box>
    )

  // (6) Em execução: nome recuado e, embaixo, tempo e o que faz agora; raia à direita; cartão no hover.
  const esq = grafico ? Math.min(36, Math.floor(larg * 0.5)) : larg
  const pxFaixa = Math.max(80, (larg - esq - 2) * PX)
  // A janela segue o trabalho atual (rodando ou terminado há menos de 2 min); falha antiga não visto não a estica.
  const atuais = linhas.flatMap(l => (l.tipo === 'trabalhador' && (l.t.situacao === 'rodando' || m.agora - (l.t.fim ?? 0) < 120_000) ? [l.t.inicio] : []))
  const visiveis = atuais.length ? atuais : linhas.flatMap(l => (l.tipo === 'trabalhador' ? [l.t.inicio] : []))
  const JANELA = janelaDe(visiveis.length ? Math.min(...visiveis) : m.agora, m.agora)
  // Workflow diz quantos agentes já entregaram, em vez do "agora" de quando começou.
  const fazAgora = (t: Trabalhador) => {
    if (t.tipo !== 'workflow') return limpo(t.agora)
    const ags = todos.filter(f => f.pai === t.id && f.tipo === 'agente-wf')
    return ags.length ? `${ags.filter(f => f.situacao !== 'rodando').length} de ${ags.length} prontos` : 'iniciando os agentes'
  }
  const linhaTrab = (l: Extract<Linha, { tipo: 'trabalhador' }>) => {
    const t = l.t
    const cor = corDe(t)
    const rodando = t.situacao === 'rodando'
    const tv = { ...t, ultimoSinal: sinal(t) }
    const silencio = rodando ? calado(tv, m.agora) : 0
    const nome = `${l.nome}${l.ordinal ? ` #${l.ordinal}` : ''}`
    const duracao = tempo((t.fim ?? m.agora) - t.inicio)
    // Terminal: o que a raia diria, em palavras (o fim já aparece na segunda linha).
    const estado =
      silencio > LIMITES.calado ? [`sem sinal há ${semSinal(silencio)}`, P.aviso]
      : rodando && t.pct !== undefined ? [`${Math.round(t.pct)}%`, P.texto]
      : ['', '']
    const tokens = (t.tokensNovos ?? 0) + (t.tokensCache ?? 0) > 0
    return (
      <Box key={`linha:${t.id}`} flexDirection="column" hover={{ backgroundColor: P.cartao }}>
        <Box flexDirection="row">
          <Box flexDirection="column" width={esq}>
            <Box flexDirection="row" gap={1}>
              <Text color={P.apagado}>
                {recuo(l.nivel)}
                <Text color={cor}>●</Text>
              </Text>
              <Button plain key={`abrir:${t.id}`} label={corta(nome, Math.max(10, esq - l.nivel * 2 - 4))} onPress={() => void acoes.abrir(t.id)} />
              {!grafico && estado[0] ? <Text color={estado[1]}>{estado[0]}</Text> : null}
            </Box>
            <Box flexDirection="row">
              <Text color={P.apagado}>{'  '.repeat(l.nivel + 1)}</Text>
              {rodando
                ? <Client key={`tempo:${t.id}`} module="./relogio.tsx" props={{ desde: t.inicio, base: m.agora }} />
                : <Text color={P.apagado}>{duracao}</Text>}
              <Text color={t.situacao === 'falhou' ? P.pendencia : P.apagado} wrap="truncate-end">
                {` · ${[quemGasta(t, todos.filter(f => f.pai === t.id)), rodando ? fazAgora(t) : t.situacao === 'falhou' ? 'falhou' : 'concluído'].filter(Boolean).join(' · ')}`}
              </Text>
            </Box>
          </Box>
          {grafico ? <Svg {...tam(faixa(tv, m.agora, JANELA, pxFaixa, cor))} alt={`${nome}: ${limpo(t.agora)}`} /> : null}
        </Box>
        <Box position="absolute" top={2} left={4} display="none" hover={{ display: 'flex' }} flexDirection="column" borderStyle="round" borderColor={P.borda} backgroundColor={P.cartao} paddingX={1}>
          {t.modelo ? <Text color={P.secundario}>{`modelo ${modeloCurto(t.modelo)}`}</Text> : null}
          {tokens ? <Text color={P.secundario}>{`tokens ${mil(t.tokensNovos ?? 0)} novos · ${mil(t.tokensCache ?? 0)} em cache`}</Text> : null}
          <Text color={P.secundario}>{`tempo ${duracao}`}</Text>
          {t.rotulo ? <Text color={P.apagado} wrap="truncate-end">{limpo(t.rotulo)}</Text> : null}
        </Box>
      </Box>
    )
  }
  const linhaResumo = (l: Extract<Linha, { tipo: 'resumo' }>) => (
    <Text color={l.situacao === 'falhou' ? P.pendencia : l.situacao === 'rodando' ? P.secundario : P.ok}>{`${recuo(l.nivel)}${l.texto}`}</Text>
  )
  const execucao = !ocioso && linhas.length > 0 && (
    <Box flexDirection="column">
      <Text bold color={P.secundario}>Em execução</Text>
      {linhas.map(l => (l.tipo === 'resumo' ? linhaResumo(l) : linhaTrab(l)))}
    </Box>
  )

  // Detalhe do trabalhador aberto: últimas ações, cauda da saída, explicação e botões.
  const sel = m.aberto ? m.trabalhadores[m.aberto] : undefined
  const detalhe = sel && (
    <Box flexDirection="column" borderStyle="round" borderColor={P.borda} backgroundColor={P.cartao} paddingX={1} gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={P.texto} wrap="truncate-end">{nomeHumano(sel)}</Text>
        <Button plain key={`fechar:${sel.id}`} label="Fechar" onPress={() => void acoes.abrir(sel.id)} />
      </Box>
      {sel.tarefa ? <Text color={P.secundario}>{limpo(sel.tarefa)}</Text> : null}
      {sel.acoes.length > 0 && <Code source={sel.acoes.slice(-8).map(a => `${hora(a.t)} ${a.erro ? '✕' : '·'} ${limpo(a.texto)}`).join('\n')} wrap="truncate-end" />}
      {(sel.cauda?.length ?? 0) > 0 && <Code source={(sel.cauda ?? []).slice(-12).map(limpo).join('\n')} wrap="truncate-end" />}
      {sel.explicacao ? <Markdown text={limpo(sel.explicacao)} /> : sel.explicando ? <Text color={P.apagado}>explicando…</Text> : null}
      <Box flexDirection="row" gap={1}>
        {!sel.explicacao && !sel.explicando && <Button key={`explicar:${sel.id}`} label="Explicar" onPress={() => void acoes.explicar(sel.id)} />}
        {sel.situacao === 'rodando' && <Button key={`parar:${sel.id}`} label="Parar" onPress={() => void acoes.parar(sel.id)} />}
      </Box>
    </Box>
  )

  // (7) Histórico: fita das ações do principal; aberto, lista agrupada (miúdas juntas) com os trabalhos concluídos.
  const nAcoes = m.principal.acoes.length
  type Item = { t: number; w?: Trabalhador; a?: Acao; n?: number }
  const lista = (): Item[] => {
    const itens: Item[] = [
      ...todos.filter(w => w.situacao !== 'rodando').map(w => ({ t: w.fim ?? w.inicio, w })),
      ...m.principal.acoes.map(a => ({ t: a.t, a })),
    ].sort((x, y) => y.t - x.t)
    const grupos: Item[] = []
    for (const it of itens) {
      const miuda = !!it.a && !it.a.erro && (it.a.tipo === 'leitura' || it.a.tipo === 'busca' || it.a.tipo === 'edicao')
      const ult = grupos[grupos.length - 1]
      if (miuda && ult?.n) ult.n++
      else grupos.push(miuda ? { t: it.t, n: 1 } : it)
    }
    return grupos.slice(0, 20)
  }
  const historico = (nAcoes > 0 || todos.some(w => w.situacao !== 'rodando')) && (
    <Box flexDirection="column">
      {grafico && !ocioso && nAcoes > 0 ? <Svg {...tam(fita(m.principal.acoes, m.agora, larg * PX))} alt={`Fita das últimas ${nAcoes} ações`} /> : null}
      <Button plain key="historico" label={`${m.historicoAberto ? '▾' : '▸'} Histórico · ${plural(nAcoes, 'ação', 'ações')}`} onPress={() => void acoes.alternar('historicoAberto')} />
      {m.historicoAberto && lista().map(g =>
        g.w ? (
          <Button plain key={`hist:${g.w.id}`} label={`  ${hora(g.t)} ${g.w.situacao === 'falhou' ? '✕' : '✓'} ${nomeHumano(g.w)} · ${tempo((g.w.fim ?? g.t) - g.w.inicio)}`} onPress={() => void acoes.abrir(g.w!.id)} />
        ) : g.n ? (
          <Text color={P.apagado}>{`  ${hora(g.t)} · ${g.n === 1 ? '1 leitura, busca ou edição' : `${g.n} leituras, buscas e edições`}`}</Text>
        ) : (
          <Text color={g.a?.erro ? P.pendencia : P.secundario} wrap="truncate-end">{`  ${hora(g.t)} ${g.a?.erro ? '✕' : '·'} ${limpo(g.a?.texto)}`}</Text>
        ),
      )}
    </Box>
  )

  // (8) Uso: duas barras finas e discretas, com a hora em que renovam.
  const linhaUso = (rotulo: string, pct?: number, iso?: string) =>
    pct !== undefined && (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text color={P.apagado}>{rotulo.padEnd(6)}</Text>
        {grafico ? <Svg {...tam(barraUso(pct, 96, pct >= 80 ? P.aviso : P.secundario))} alt={`${rotulo} ${Math.round(pct)}%`} /> : null}
        <Text color={pct >= 80 ? P.aviso : P.apagado}>{`${Math.round(pct)}%${renova(m.agora, iso)}`}</Text>
      </Box>
    )
  const uso = (m.uso.cota5h !== undefined || m.uso.semana !== undefined) && (
    <Box flexDirection="column">
      <Text color={P.apagado}>Uso</Text>
      {linhaUso('5h', m.uso.cota5h, m.uso.renova5h)}
      {linhaUso('7 dias', m.uso.semana, m.uso.renovaSemana)}
    </Box>
  )

  return (
    <Box flexDirection="column" gap={1}>
      {topo}
      {vered}
      {sessoes}
      {secao('Pendências', at.pendencias, at.maisPendencias, P.pendencia, 'pend')}
      {secao('Avisos', at.avisos, at.maisAvisos, P.aviso, 'aviso')}
      {execucao}
      {detalhe}
      {historico}
      {uso}
    </Box>
  )
}

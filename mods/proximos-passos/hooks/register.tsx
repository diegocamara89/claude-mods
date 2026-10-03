import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Opcao } from '../types'

// Depois de cada resposta, o Haiku propõe 3 próximos pedidos (botões acima da caixa).
// Medido em 02/10: o Haiku lê ~1 mil tokens; o modelo principal releria a conversa inteira (~850 mil).
const opcoes = atom({ plugin: 'proximos-passos', key: 'opcoes' } as const, [])
const gerando = atom({ plugin: 'proximos-passos', key: 'gerando' } as const, false)
const nativa = atom({ plugin: 'proximos-passos', key: 'nativa' } as const, '')

const SISTEMA = `Você sugere os próximos passos de uma conversa de trabalho entre um usuário e o assistente Claude.
O usuário escreve curto e direto e decide o que fazer; o assistente executa. Escreva os pedidos no idioma em que o usuário escreve.
Leia o último pedido do usuário e a resposta do assistente e proponha exatamente 3 próximos pedidos que o USUÁRIO mandaria agora.
- Se a resposta terminou com uma pergunta ou com opções, as sugestões são as respostas plausíveis a ela (a recomendada primeiro).
- Senão, os passos mais úteis a partir dali: continuar, conferir/testar, ou mudar de rumo.
- Cada pedido escrito como o usuário escreveria, na primeira pessoa dele, imperativo curto ("sim, pode aplicar").
- Nada genérico ("continue", "obrigado"). Nada que repita o que já foi feito.
Responda APENAS um JSON válido, sem cercas de código: [{"rotulo": "<até 6 palavras>", "pedido": "<o texto que será enviado>"}, ...]`

let ultimoPedido = ''

// Tokens exatamente como a resposta da Anthropic informa (campo usage).
async function medir($: any, modo: 'turno' | 'haiku', ms: number, u: any) {
  const m = {
    modo, ms,
    novos: Number(u?.input_tokens ?? 0),
    cache: Number(u?.cache_read_input_tokens ?? 0),
    escrita: Number(u?.cache_creation_input_tokens ?? 0),
    saida: Number(u?.output_tokens ?? 0),
  }
  const lista = ((await $.store.get('medicoes2')) as any[] | undefined) ?? []
  await $.store.set('medicoes2', [...lista, m].slice(-600))
}

function ler(texto: string): Opcao[] {
  const j = JSON.parse(String(texto).replace(/^[\s\S]*?(\[)/, '$1').replace(/\][^\]]*$/, ']'))
  return Array.isArray(j)
    ? j.filter((o: any) => o?.rotulo && o?.pedido).slice(0, 3)
      .map((o: any) => ({ rotulo: String(o.rotulo).slice(0, 60), pedido: String(o.pedido) }))
    : []
}

async function sugerir($: any, resposta: string) {
  await update($, gerando, () => true)
  let lista: Opcao[] = []
  try {
    const t0 = await $.clock.now()
    const r: any = await $.model.complete({
      model: 'haiku', system: SISTEMA, maxTokens: 300, timeoutMs: 15_000,
      prompt: `Último pedido do usuário:\n${ultimoPedido.slice(0, 1000)}\n\nFim da resposta do assistente:\n${resposta.slice(-3000)}`,
    })
    await medir($, 'haiku', (await $.clock.now()) - t0, r.usage).catch(() => undefined)
    if (r.isAnswered) lista = ler(r.text)
  } catch {
    /* erro, limite de tempo ou resposta fora do formato: sem sugestão desta vez */
  } finally {
    // Sempre desliga o "pensando", senão a faixa fica presa.
    await update($, opcoes, () => lista)
    await update($, gerando, () => false)
  }
}

const fmt = (n: number) => Math.round(n).toLocaleString('pt-BR')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'custos', description: 'Tokens das sugestões comparados com uma resposta normal' })
    // Um recarregamento no meio de uma sugestão deixaria o "pensando" ligado para sempre.
    await update($, gerando, () => false)
    return next(e)
  })

  on('command.run', { command: 'custos' }, async $ => {
    const todas = (((await $.store.get('medicoes2')) as any[] | undefined) ?? []).filter(m => m.modo !== 'claude')
    if (!todas.length) return { text: 'Ainda não há medições.' }
    const nomes: Record<string, string> = { turno: 'Resposta normal do Claude (referência)', haiku: 'Sugestões pelo Haiku' }
    const linhas: string[] = ['Médias por chamada, em tokens, como a Anthropic informa:']
    for (const modo of ['turno', 'haiku']) {
      const l = todas.filter(m => m.modo === modo)
      if (!l.length) continue
      const media = (k: string) => l.reduce((s, m) => s + Number(m[k] ?? 0), 0) / l.length
      const ms = l.map(m => m.ms).filter(Boolean).sort((a, b) => a - b)
      linhas.push(
        `• ${nomes[modo]} (${l.length}): ${fmt(media('cache'))} lidos do cache · ${fmt(media('novos'))} novos · ${fmt(media('escrita'))} gravados no cache · ${fmt(media('saida'))} de saída` +
        (ms.length ? ` · ${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1)} s` : ''),
      )
    }
    return { text: linhas.join('\n') }
  })

  // Só para não repetir nos botões o que já está no Tab.
  on('prompt.suggest', async ($, e: any, next) => {
    if (e.origin?.kind === 'suggestion' && e.text) await update($, nativa, () => String(e.text))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    ultimoPedido = e.text
    await update($, opcoes, () => [])
    await update($, nativa, () => '')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || e.reason !== 'answer') return r
    if (e.usage) await medir($, 'turno', e.durationMs, e.usage).catch(() => undefined)
    // Mensagens automáticas de outros mods e respostas curtas não pedem sugestão.
    // Mensagem automática de outro mod começa com "[nome-do-mod]".
    if (/^\s*\[[\w-]+\]/.test(ultimoPedido) || e.answer.split(/\s+/).length < 15) return r
    void sugerir($, e.answer)
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const n = await read($, nativa)
    const mesmo = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
    const botoes = (await read($, opcoes)).filter(o => !n || !mesmo(o.pedido, n))
    const ocupado = await read($, gerando)
    if (e.props.hasSurvey || e.props.isWorking || (!botoes.length && !ocupado)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const enviar = (o: Opcao) => async () => {
      await update($, opcoes, () => [])
      await $.prompt.submit({ text: o.pedido, asUser: true })
    }
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {ocupado && !botoes.length && <Text dimColor>pensando nos próximos passos…</Text>}
        {botoes.map((o, i) => (
          <Button key={`op${i}`} label={o.rotulo} hotkey={String(i + 1)} {...(i === 0 ? { variant: 'primary' as const } : {})} onPress={enviar(o)} />
        ))}
        {botoes.length > 0 && <Button key="fechar" plain label="✕" role="dismiss" onPress={() => update($, opcoes, () => [])} />}
      </Box>
    )
  })
}

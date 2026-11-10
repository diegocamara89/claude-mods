import type { Register } from 'claude-code'

// Palavras de ligação: dizem o idioma de uma frase mesmo cheia de termo técnico.
const PT = new Set(('de que não nao para com uma um os as é do da dos das em no na nos nas se por mais como mas ao ' +
  'isso isto está esta são foi ser ter tem já ainda também quando onde porque então pelo pela seu sua ' +
  'você voce ele ela eu nós aqui agora depois antes cada muito pode deve fica vai vou').split(' '))
const EN = new Set(('the and is are to of in that it for with this you be on not have will can was were ' +
  'which would should could there their they them what when where your from but also been has had ' +
  'into then than only just about here now each very may must let lets').split(' '))

const AVISO = '[trava-portugues] Sua última resposta saiu em inglês. Reescreva-a inteira em português do Brasil, sem mudar o conteúdo.'
const LEMBRETE = 'Lembrete da trava-portugues: este resultado está em inglês; responda ao usuário em português do Brasil.'
// O usuário pediu inglês de propósito: a trava fica quieta nesse turno.
const PEDIU_INGLES = /\b(em|in|para o|to)\s+ingl[eê]s\b|\bin english\b|\btranslate\b/i

function contar(texto: string) {
  const prosa = texto
    .replace(/```[\s\S]*?```/g, ' ')          // blocos de código
    .replace(/`[^`\n]*`/g, ' ')               // código em linha
    .replace(/https?:\/\/\S+/g, ' ')          // links
    .replace(/\S*[\\/]\S*/g, ' ')             // caminhos
    .replace(/^\s*>.*$/gm, ' ')               // citações
    .toLowerCase()
  let pt = 0, en = 0, total = 0
  for (const p of prosa.match(/[a-zà-ÿ']+/g) ?? []) {
    total++
    if (PT.has(p)) pt++
    else if (EN.has(p)) en++
  }
  return { pt, en, total }
}

const emIngles = (texto: string, minimo = 20) => {
  const c = contar(texto)
  return c.total >= minimo && c.en >= 6 && c.en > 2 * c.pt
}

// Estado por turno, só do loop principal.
let turnoAtual = ''
let turnoDaTrava = false
let turnoComIngles = false
let lembreteDado = false

export const register: Register = on => {
  on('turn.start', async ($, e, next) => {
    turnoAtual = e.turnId
    turnoDaTrava = e.text.includes('[trava-portugues]')
    turnoComIngles = PEDIU_INGLES.test(e.text)
    lembreteDado = false
    return next(e)
  })

  // Prevenção: o erro nasce depois de ler doc, erro ou log em inglês.
  on('tool.call', async ($, e, next) => {
    const r: any = await next(e)
    if ((e as any).agentId || lembreteDado || turnoComIngles || r?.deny !== undefined) return r
    const texto = String(r?.text ?? '')
    if (texto.length < 400 || !emIngles(texto.slice(0, 20_000), 40)) return r
    lembreteDado = true
    return { ...r, context: [...(r.context ?? []), LEMBRETE] }
  })

  // Correção: a resposta final saiu em inglês mesmo assim.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || e.reason !== 'answer' || turnoComIngles || e.turnId !== turnoAtual) return r
    if (!emIngles(e.answer)) return r
    if (turnoDaTrava) {
      $.ui.toast('trava-portugues: a reescrita ainda saiu em inglês; não peço de novo')
      return r
    }
    $.ui.toast('trava-portugues: resposta em inglês, pedindo reescrita')
    void $.prompt.submit({ text: AVISO })
    return r
  })
}

// Outras sessões, em funções PURAS. Cada sessão publica o próprio resumo no $.store numa chave `sessao:<id>`
// e lê as das outras (o $.store lista as chaves, então não precisa de índice; cada uma só escreve a sua).
// As chamadas ao $.store ficam em coleta.ts (o motor só segue o $ dentro do próprio arquivo).

import type { ResumoSessao } from '../types'

const PREFIXO = 'sessao:'
export const FRESCA = 120_000 // sem publicar há mais que isto: não aparece
const ABANDONADA = 86_400_000 // chave de sessão que fechou sem avisar: apagada depois de um dia

export const chaveSessao = (id: string) => PREFIXO + id
export const ehSessao = (chave: string) => chave.startsWith(PREFIXO)

/** Das entradas `sessao:*` do $.store (sem a própria): resumos frescos, em ordem fixa, e chaves para apagar. */
export function separar(entradas: [string, unknown][], agora: number): { outras: ResumoSessao[]; apagar: string[] } {
  const outras: ResumoSessao[] = []
  const apagar: string[] = []
  for (const [k, v] of entradas) {
    const r = v as ResumoSessao | undefined
    if (!r || typeof r.t !== 'number') continue
    if (agora - r.t > ABANDONADA) apagar.push(k)
    else if (agora - r.t <= FRESCA) outras.push(r)
  }
  return { outras: outras.sort((a, b) => (a.id < b.id ? -1 : 1)), apagar } // ordem fixa: a lista não pula
}

/** Precisa regravar a lista? Se mudou algo além da hora, ou se a hora guardada envelheceu (frescor no desenho). */
export function sessoesMudaram(novas: ResumoSessao[], atuais: ResumoSessao[], agora: number): boolean {
  const sem = (l: ResumoSessao[]) => JSON.stringify(l.map(s => ({ ...s, t: 0 })))
  return sem(novas) !== sem(atuais) || atuais.some(s => agora - s.t > 60_000)
}

import type { Acao, Trabalhador } from '../types'
import { LIMITES, calado, tempo } from './regras'

// Desenhos parados em SVG (o motor recria o SVG a cada redesenho: nada de animação, hover ou <title>).
// Tudo puro: recebe dados, devolve a marcação.

// Paleta pastel (SPEC): mesmas cores de sempre, dessaturadas, para cansar menos a vista.
export const PALETA = {
  fundo: '#1f1f1e',
  cartao: '#262624',
  borda: '#3a3936',
  texto: '#e6e4df',
  secundario: '#a8a59e',
  apagado: '#77746e',
  ok: '#9cc5a1',
  aviso: '#d9bf8c',
  avisoFundo: '#2a2620',
  avisoBorda: '#574c36',
  pendencia: '#d9a0a0',
  pendenciaFundo: '#2b2322',
  pendenciaBorda: '#5e4644',
  agentes: '#9db4d9',
  gemini: '#c9a8d0',
  codex: '#93c4c4',
  comando: '#a3a3a3',
}
const P = PALETA
const FONTE = 'Segoe UI,system-ui,sans-serif'

// Texto dentro do SVG: escapa o que quebraria a marcação.
export const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const n1 = (v: number) => +v.toFixed(1)
const svg = (w: number, h: number, rotulo: string, corpo: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(rotulo)}">${corpo}</svg>`
const texto = (x: number, y: number, s: string, cor: string, tam: number, extra = '') =>
  `<text x="${n1(x)}" y="${n1(y)}" font-size="${tam}" fill="${cor}" font-family="${FONTE}"${extra}>${esc(s)}</text>`
const cortar = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)
// Silêncio em frase ("sem sinal há 6 min"): acima de 1 min, só minutos inteiros.
export const semSinal = (ms: number) => tempo(ms < 60_000 ? ms : Math.floor(ms / 60_000) * 60_000)

// Raia de um trabalhador na janela [agora - janelaMs, agora]: barra até o fim (ou até agora),
// um ponto por ação, trecho hachurado âmbar onde há silêncio acima do limite, e um rótulo curto à direita.
export function faixa(t: Trabalhador, agora: number, janelaMs: number, larguraPx: number, cor: string): string {
  const W = Math.max(60, Math.round(larguraPx))
  const H = 30
  const y = 20
  const x0 = 4
  const x1 = W - 8
  const ini = agora - janelaMs
  const x = (ms: number) => n1(x0 + Math.min(1, Math.max(0, (ms - ini) / janelaMs)) * (x1 - x0))
  const rodando = t.situacao === 'rodando'
  const silencio = rodando ? calado(t, agora) : 0
  const travou = silencio > LIMITES.calado
  const a = x(t.inicio)
  const b = Math.max(x(travou ? agora - silencio : t.fim ?? agora), a + 3)
  const partes = [
    `<line x1="${x0}" y1="${y + 0.5}" x2="${x1}" y2="${y + 0.5}" stroke="${P.borda}"/>`,
    `<rect x="${a}" y="${y - 4}" width="${n1(b - a)}" height="9" rx="4.5" fill="${cor}" fill-opacity="${rodando ? 0.85 : 0.4}"/>`,
  ]
  if (travou && x1 - b > 1) {
    partes.unshift(
      `<defs><pattern id="h" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="${P.avisoFundo}"/><line x1="0" y1="0" x2="0" y2="5" stroke="${P.aviso}" stroke-width="2"/></pattern></defs>`,
    )
    partes.push(`<rect x="${b}" y="${y - 5}" width="${n1(x1 - b)}" height="11" rx="2" fill="url(#h)" stroke="${P.aviso}" stroke-width="1" stroke-dasharray="3 2"/>`)
  }
  for (const ac of t.acoes ?? []) {
    if (ac.t < ini) continue
    partes.push(`<circle cx="${x(ac.t)}" cy="${y + 0.5}" r="1.9" fill="${ac.erro ? P.pendencia : '#f2f0ea'}" fill-opacity="0.8"/>`)
  }
  // Marca do fim: viva em "agora"; concluída na cor do resultado.
  const marca = rodando ? (travou ? P.aviso : cor) : t.situacao === 'falhou' ? P.pendencia : t.situacao === 'feito' ? P.ok : P.apagado
  partes.push(`<circle cx="${rodando ? x1 : b}" cy="${y + 0.5}" r="4" fill="${marca}" stroke="${P.fundo}" stroke-width="1.5"/>`)
  const [rotulo, corRotulo] = travou
    ? [`sem sinal há ${semSinal(silencio)}`, P.aviso]
    : rodando && t.pct !== undefined
      ? [`${Math.round(t.pct)}%`, P.texto]
      : rodando && t.tipo === 'agy' && t.passos
        ? [`passo ${t.passos}`, cor]
        : t.situacao === 'falhou'
          ? ['falhou', P.pendencia]
          : ['', '']
  if (rotulo) partes.push(texto(x1, 10, rotulo, corRotulo, 10.5, ' text-anchor="end" font-weight="600"'))
  return svg(W, H, t.rotulo || t.id, partes.join(''))
}

// Altura e cor de cada tipo de ação na fita (mais alto = mais consequente).
const TIPO: Record<Acao['tipo'], [number, string]> = {
  leitura: [10, P.apagado],
  busca: [14, P.agentes],
  web: [14, P.codex],
  outro: [10, P.borda],
  agente: [19, P.gemini],
  comando: [19, P.comando],
  edicao: [24, P.texto],
}

// Fita das ações do principal: uma barrinha por ação, da mais antiga (até 40 min) até agora. Sem legenda:
// a altura já diz o peso (edição > comando > busca > leitura).
export function fita(acoes: Acao[], agora: number, larguraPx: number): string {
  const W = Math.max(120, Math.round(larguraPx))
  const H = 44
  const base = 30
  const recentes = acoes.filter(a => a.t <= agora && a.t >= agora - 40 * 60_000)
  const desde = recentes.length ? Math.min(...recentes.map(a => a.t)) : agora
  const janela = Math.min(40 * 60_000, Math.max(2 * 60_000, (agora - desde) * 1.08))
  const ini = agora - janela
  const partes = [`<line x1="0" y1="${base + 0.5}" x2="${W}" y2="${base + 0.5}" stroke="${P.borda}"/>`]
  for (const a of recentes) {
    const [alt, cor] = TIPO[a.tipo] ?? TIPO.outro
    const x = n1(((a.t - ini) / janela) * (W - 4))
    partes.push(`<rect x="${x}" y="${base - alt}" width="3.4" height="${alt}" rx="1" fill="${a.erro ? P.pendencia : cor}"/>`)
  }
  partes.push(texto(0, 42, `há ${tempo(janela).replace(/\s?\d+s$/, '')}`, P.apagado, 10), texto(W, 42, 'agora', P.apagado, 10, ' text-anchor="end"'))
  return svg(W, H, `Fita das últimas ${recentes.length} ações`, partes.join(''))
}

// Barra fina de uso (cota): trilho e parte cheia.
export function barraUso(pct: number, larguraPx: number, cor: string): string {
  const W = Math.max(20, Math.round(larguraPx))
  const cheio = n1((Math.min(100, Math.max(0, pct)) / 100) * W)
  return svg(
    W,
    6,
    `${Math.round(pct)}% usado`,
    `<rect x="0" y="1" width="${W}" height="4" rx="2" fill="${P.borda}"/><rect x="0" y="1" width="${cheio}" height="4" rx="2" fill="${cor}"/>`,
  )
}

// Quebra em até `max` linhas de `n` caracteres; a última leva o resto, cortado com reticências.
function quebrar(s: string, n: number, max: number): string[] {
  const linhas: string[] = []
  let atual = ''
  for (const p of s.split(/\s+/).filter(Boolean)) {
    if (!atual) atual = p
    else if (atual.length + 1 + p.length <= n) atual += ' ' + p
    else {
      linhas.push(atual)
      atual = p
    }
  }
  if (atual) linhas.push(atual)
  if (linhas.length <= max) return linhas.map(l => cortar(l, n))
  return [...linhas.slice(0, max - 1), cortar(linhas.slice(max - 1).join(' '), n)]
}

// Manchete grande (Text não tem tamanho de fonte; SVG tem) e a linha de baixo, menor.
export function titulo(textoGrande: string, sub: string, corTexto: string, corSub: string, larguraPx: number): string {
  const W = Math.max(120, Math.round(larguraPx))
  const F = 16
  const f = 12.5
  const linhas = quebrar(textoGrande, Math.max(8, Math.floor((W - 4) / (F * 0.56))), 2)
  const partes = linhas.map((l, i) => texto(0, F + i * (F + 5), l, corTexto, F, ' font-weight="600"'))
  let H = linhas.length * (F + 5) + 2
  if (sub) {
    H += f + 4
    partes.push(texto(0, H - 4, cortar(sub, Math.floor((W - 4) / (f * 0.52))), corSub, f, ' font-weight="600"'))
  }
  return svg(W, Math.ceil(H), `${textoGrande}. ${sub}`, partes.join(''))
}

import type { ClientModule } from 'claude-code'

// Tempo corrente que conta sozinho a cada segundo, mesmo sem redesenho do painel.
// props: desde = início (ms); base = o "agora" do último desenho do painel; cor opcional.
// Conta a partir de `base - desde` e recomeça quando o painel manda uma base nova.
type Props = { desde: number; base: number; cor?: string }
type Estado = { base: number; n: number }

// Cópia de regras.tempo ("45s", "7min 47s", "12 min", "1h 05min"): o módulo de superfície fica sozinho.
function tempo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 10) return s % 60 ? `${m}min ${s % 60}s` : `${m} min`
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}min`
}

const Relogio: ClientModule<Props, Estado> = (p, s) => {
  const { Text } = s.elements
  if (s.state === undefined) {
    // Um único laço por instância, iniciado no primeiro desenho.
    s.setState({ base: p.base, n: 0 })
    s.every(1000, () => {
      const st = s.state
      if (st) s.setState({ base: st.base, n: st.n + 1 })
    })
  } else if (s.state.base !== p.base) {
    // Props novas (o painel redesenhou): só aqui, nunca em todo desenho.
    s.setState({ base: p.base, n: 0 })
  }
  const n = s.state?.base === p.base ? s.state.n : 0
  return <Text {...(p.cor ? { color: p.cor } : { dimColor: true })}>{tempo(p.base - p.desde + n * 1000)}</Text>
}

export default Relogio

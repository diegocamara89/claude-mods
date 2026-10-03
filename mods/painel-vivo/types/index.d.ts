export type Chamada = {
  id: string
  tool: string
  desc: string
  cmd: string
  inicio: number
  fim?: number
  erro?: boolean
  log?: string
  cauda?: string[]
  pct?: number
  ultimaSaida?: number
  explicacao?: string
  explicando?: boolean
  rotulo?: string
  agente?: string
  pai?: string
  modelo?: string
  agys?: Agy[]
}
export type Agy = { arquivo: string; modelo: string; passos: number; agora: string; fim: boolean; status: string; mtime?: number }
export type Agente = { pai: string; tipo: string; modelo: string; fundo?: boolean; esforco?: string }
export type Termo = { termo: string; definicao: string }
export type Contexto = { pct?: number; tokens?: number; janela: number; cota5h?: number; semana?: number }
export type Principal = { modelo: string; esforco?: string }

declare module 'claude-code' {
  interface PluginState {
    'painel-vivo': { chamadas: Chamada[]; aberta: string; verGlossario: boolean; glossario: Termo[]; agentes: Record<string, Agente>; vistos: string[]; historicoAberto: boolean; contexto: Contexto; principal: Principal }
  }
}

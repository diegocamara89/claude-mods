// Contrato do painel (v2). Coleta grava; regras derivam; desenho lê. Ver SPEC.md.

/** Tipo do trabalhador: define cor, nome humano e regras de silêncio. */
export type Tipo = 'subagente' | 'workflow' | 'agente-wf' | 'comando' | 'agy' | 'codex' | 'pergunta'

export type Situacao = 'rodando' | 'feito' | 'falhou' | 'parado'

/** Um ponto na raia: uma ação vista. */
export type Acao = { t: number; tipo: 'leitura' | 'busca' | 'edicao' | 'comando' | 'web' | 'agente' | 'outro'; texto: string; erro?: boolean }

export type Trabalhador = {
  id: string                 // tool_use_id da chamada; agente de workflow: `ag:<agentId>`
  tipo: Tipo
  pai: string                // id de quem chamou; 'principal' para o agente principal
  rotulo: string             // nome técnico: rótulo do workflow, subagentType, descrição do comando
  fase?: string              // fase do workflow (agente-wf)
  tarefa?: string            // o que pediram (prompt ou descrição, até 300 caracteres)
  agora: string              // o que faz agora, em português simples
  inicio: number
  fim?: number
  situacao: Situacao
  ultimoSinal: number        // última atividade vista (ferramenta, trecho do modelo, saída, passo do agy)
  acoes: Acao[]              // últimas 60
  agentId?: string           // subagente/agente-wf: o agentId do motor
  modelo?: string
  tokensNovos?: number       // entrada + saída + criação de cache
  tokensCache?: number       // releitura de cache (barata)
  pct?: number               // porcentagem real informada pela saída do comando
  passos?: number            // agy: passos dados
  plano?: Plano              // checklist declarado (TodoWrite/TaskCreate/TaskUpdate) por este agente
  emFundo?: boolean
  tarefaFundo?: string       // id da tarefa em segundo plano (para fechar no aviso de término)
  log?: string               // arquivo com a saída do comando
  agyDir?: string            // pasta onde o agy grava os passos (AGY_EVENTS_DIR)
  cauda?: string[]           // últimas linhas da saída
  explicacao?: string
  explicando?: boolean
}

export type Plano = { feitos: number; total: number; atual?: string }

/** Sinal que exige ação do usuário e não deriva só do tempo. */
export type Pendente = {
  id: string                 // tool_use_id
  tipo: 'permissao' | 'pergunta' | 'plano' | 'falha-api'
  titulo: string             // "Permissão para rodar: apagar a pasta build"
  detalhe?: string
  quem: string               // id do trabalhador (ou 'principal')
  desde: number
}

/** Item mostrado em Pendências (nivel 'pendencia') ou Avisos (nivel 'aviso'). Derivado em regras.ts. */
export type Atencao = {
  id: string
  nivel: 'pendencia' | 'aviso'
  tipo: 'permissao' | 'pergunta' | 'plano' | 'falha-api' | 'erro' | 'travado' | 'calado' | 'contexto' | 'cota' | 'sessao'
  titulo: string
  detalhe?: string
  quem?: string
  desde: number
  acoes: ('explicar' | 'dispensar' | 'parar' | 'esperar')[]
}

export type Workflow = { id: string; nome: string; desc: string; fases: { titulo: string; detalhe?: string }[]; dir?: string; fasePorAgente: Record<string, string>; runId?: string /* acrescentado (coleta): liga agent.spawn sem tool_use_id ao workflow */ }

export type Uso = {
  contextoPct?: number
  cota5h?: number
  renova5h?: string          // ISO
  semana?: number
  renovaSemana?: string      // ISO
}

export type Principal = {
  ocupado: boolean           // turno do agente principal em curso
  ultimoSinal: number
  fimTurno?: number
  plano?: Plano
  tokensNovos: number
  tokensCache: number
  acoes: Acao[]              // últimas 200 ações do principal (fita)
  titulo?: string            // assunto da sessão (para manchete e outras sessões)
}

/** Resumo que cada sessão publica em $.store para as outras verem. */
export type ResumoSessao = {
  id: string
  nome: string
  nivel: 'pendencia' | 'andando' | 'ocioso'
  frentes: number
  pendencias: string[]       // títulos curtos
  t: number                  // última publicação
}

/** Tudo que o desenho precisa, lido do estado num só objeto. */
export type Modelo = {
  agora: number
  trabalhadores: Record<string, Trabalhador>
  workflows: Record<string, Workflow>
  pendentes: Record<string, Pendente>
  vistos: string[]
  uso: Uso
  principal: Principal
  sessoes: ResumoSessao[]    // outras sessões (sem a atual), já filtradas por frescor
  aberto: string
  historicoAberto: boolean
  sessoesAbertas: boolean
  verGlossario: boolean
  glossario: { termo: string; definicao: string }[]
}

/** Linha da seção "Em execução", já ordenada e recortada por regras.arvore(). */
export type Linha =
  | { tipo: 'trabalhador'; t: Trabalhador; nivel: number; nome: string; ordinal?: number }
  | { tipo: 'resumo'; nivel: number; texto: string; situacao: 'feito' | 'rodando' | 'falhou'; ids: string[] }

export type Veredito = {
  nivel: 'pendencia' | 'aviso' | 'andando' | 'ocioso'
  manchete: string
  sub: string
  tiles: { rotulo: string; valor: string; detalhe: string; nivel: 'ok' | 'aviso' | 'pendencia' | 'neutro' }[]
}

/**
 * Ações dos botões, já presas ao $ por quem desenha (register.tsx). O motor recusa o módulo que passa
 * o $ para função importada ("$ is followed only into a function declared in this same file"), então
 * desenho.tsx recebe `desenharPainel($.ui.resolve(e), e, m, acoes)` em vez do $.
 */
export type Acoes = {
  abrir: (id: string) => unknown
  dispensar: (ids: string[]) => unknown
  explicar: (id: string) => unknown
  parar: (id: string) => unknown
  alternar: (chave: 'historicoAberto' | 'sessoesAbertas' | 'verGlossario') => unknown
}

declare module 'claude-code' {
  interface PluginState {
    'painel-vivo': {
      trabalhadores: Record<string, Trabalhador>
      workflows: Record<string, Workflow>
      pendentes: Record<string, Pendente>
      vistos: string[]
      uso: Uso
      principal: Principal
      sessoes: ResumoSessao[]
      relogio: number
      aberto: string
      historicoAberto: boolean
      sessoesAbertas: boolean
      verGlossario: boolean
      glossario: { termo: string; definicao: string }[]
    }
  }
}

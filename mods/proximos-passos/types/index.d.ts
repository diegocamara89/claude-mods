export type Opcao = { rotulo: string; pedido: string }

declare module 'claude-code' {
  interface PluginState {
    'proximos-passos': { opcoes: Opcao[]; gerando: boolean; nativa: string }
  }
}

import type { Register } from 'claude-code'

import { ligar } from './coleta'

// Entrada do mod. Os ganchos, o relógio, os comandos (/painel, /glossario) e o render do painel
// moram em coleta.ts: o motor só segue o $ para funções do próprio arquivo, nunca através de import, então
// quem recebe o $ e quem o usa precisam estar juntos. Aqui só se liga.
export const register: Register = on => ligar(on)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from '../hooks/register.ts'

// Monta o gancho como o Claude Code monta e devolve o comando que chega à ferramenta.
async function comandoQueRoda(tool: string, command: string): Promise<string> {
  let gancho: any, filtro: any
  const on: any = (_ev: string, a: any, b?: any) => { gancho = b ?? a; filtro = b ? a : undefined }
  register(on, {} as any)
  if (filtro?.tool && filtro.tool !== tool) return command // o Claude nem chama o gancho
  let recebido = ''
  const $: any = { ui: { toast: () => {} }, env: { get: async (k: string) => (k === 'OS' ? 'Windows_NT' : undefined) }, plugin: { root: 'C:/projetos/Dev/claude-mods' } }
  await gancho($, { tool, command }, async (e: any) => { recebido = e.command; return {} })
  return recebido
}

const S = 'python "C:/projetos/Dev/claude-mods/varredura.py"'

test('push pelo PowerShell do Claude passa pela varredura', async () => {
  assert.equal(await comandoQueRoda('PowerShell', 'git push origin main'), `${S} && git push origin main`)
})

test('Bash continua igual e outras ferramentas não mudam', async () => {
  assert.equal(await comandoQueRoda('Bash', 'git push origin main'), `${S} && git push origin main`)
  assert.equal(await comandoQueRoda('Read', 'git push origin main'), 'git push origin main')
})

test('liberação no formato do PowerShell', async () => {
  assert.equal(await comandoQueRoda('PowerShell', '$env:VARREDURA_OK=1; git push'), '$env:VARREDURA_OK=1; git push')
})

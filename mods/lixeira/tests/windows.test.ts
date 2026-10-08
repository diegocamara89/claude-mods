import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register, alvosQueApagam } from '../hooks/register.ts'

async function resposta(command: string, tool = 'PowerShell'): Promise<any> {
  let gancho: any
  register(((_ev: string, a: any, b?: any) => { gancho = b ?? a }) as any, {} as any)
  const $: any = { ui: { toast: () => {} } }
  return gancho($, { tool, command }, async () => ({ passou: true }))
}

test('powershell.exe com -Command é lido por dentro', () => {
  assert.deepEqual(alvosQueApagam(`powershell.exe -Command "Remove-Item 'D:/a b'"`), ['D:/a b'])
})

test('a mensagem ensina a liberação do PowerShell', async () => {
  const r = await resposta('git reset --hard HEAD~1')
  assert.match(r.deny, /\$env:LIXEIRA_OK=1;/)
})

test('desligar, reiniciar, formatar e zerar disco no Windows são sem volta', async () => {
  for (const c of ['shutdown /r /t 0', 'shutdown -s', 'Restart-Computer -Force', 'Stop-Computer',
                   'Format-Volume -DriveLetter E', 'Clear-Disk -Number 2'])
    assert.ok((await resposta(c)).deny, c)
})

test('cancelar o desligamento e a liberação passam', async () => {
  assert.equal((await resposta('shutdown /a')).passou, true)
  assert.equal((await resposta('$env:LIXEIRA_OK=1; Restart-Computer')).passou, true)
})

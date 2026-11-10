import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from '../hooks/register.ts'

// Comandos reais barrados à toa na sessão do Mi Stick (10/10/2026) e o que deve continuar barrado.
async function resposta(command: string, tool = 'PowerShell'): Promise<any> {
  let gancho: any
  register(((_ev: string, a: any, b?: any) => { gancho = b ?? a }) as any, {} as any)
  const $: any = { ui: { toast: () => {} }, env: { get: async (k: string) => (k === 'OS' ? 'Windows_NT' : undefined) }, plugin: { root: 'C:/mods/lixeira' } }
  return gancho($, { tool, command }, async () => ({ passou: true }))
}
const SP = 'C:/Users/voce/AppData/Local/Temp/claude/proj/sessao/scratchpad'

test('variável do PowerShell que aponta para o scratchpad passa, e o valor de -ErrorAction não é alvo', async () => {
  const c = `$sp = '${SP.replace(/\//g, '\\')}'; Remove-Item "$sp\\a.img","$sp\\b.img" -ErrorAction SilentlyContinue`
  assert.equal((await resposta(c)).passou, true)
})

test('variável do Bash que aponta para o scratchpad passa, inclusive a definida a partir de outra', async () => {
  const c = `S="${SP}/guarda_teste"\nrm -rf "$S"; mkdir -p "$S/bin"\nexport PATH="$S/bin:$PATH" S REDE="$S/rede"\nrm -f "$REDE"`
  assert.equal((await resposta(c, 'Bash')).passou, true)
})

test('palavra mkfs ou dd dentro de aspas (padrão de grep, comando remoto) não é comando', async () => {
  const c = `.\\stick.ps1 -Cmd 'ps -ef | grep -E "apk|mkfs|e2fsck|dd |cp " | grep -v grep'`
  assert.equal((await resposta(c)).passou, true)
  assert.equal((await resposta('git commit -m "explica git reset --hard"', 'Bash')).passou, true)
})

test('dd só é sem volta quando escreve em dispositivo', async () => {
  assert.equal((await resposta('dd if=a.img of=b.img bs=1M', 'Bash')).passou, true)
  assert.ok((await resposta('dd if=a.img of=/dev/sdb', 'Bash')).deny)
})

test('continua barrado: variável fora do scratchpad, sem definição, casca com -c e redirecionamento', async () => {
  const r = await resposta('S=C:/projetos/proj; rm -rf "$S"', 'Bash')
  assert.match(r.deny, /"C:\/projetos\/proj"/)
  assert.ok((await resposta('rm -rf "$NAO_DEFINIDA"', 'Bash')).deny)
  assert.ok((await resposta('bash -c "mkfs.ext4 /dev/sdb"', 'Bash')).deny)
  const red = await resposta('rm -f C:/projetos/x.txt 2>/dev/null', 'Bash')
  assert.match(red.deny, /lixeira\.ps1" "C:\/projetos\/x\.txt"\n/)
})

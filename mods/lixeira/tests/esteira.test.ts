import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alvosQueApagam } from '../hooks/register.ts'

test('esteira do PowerShell: o alvo vem do comando anterior', () => {
  assert.deepEqual(alvosQueApagam('Get-ChildItem C:/projetos/proj -Recurse | Remove-Item -Recurse -Force'), ['C:/projetos/proj'])
  assert.deepEqual(alvosQueApagam('gci C:/projetos/proj | rm -r -fo'), ['C:/projetos/proj'])
})

test('o que já funcionava continua igual', () => {
  assert.deepEqual(alvosQueApagam('rm -rf C:/projetos/projeto'), ['C:/projetos/projeto'])
  assert.deepEqual(alvosQueApagam('echo "rm -rf C:/projetos"'), [])
  assert.deepEqual(alvosQueApagam('rmdir vazia'), [])
  assert.deepEqual(alvosQueApagam('rmdir /s /q pasta'), ['pasta'])
})

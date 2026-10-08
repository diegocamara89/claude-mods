import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alvosQueApagam } from '../hooks/register.ts'

test('esteira do PowerShell: o alvo vem do comando anterior', () => {
  assert.deepEqual(alvosQueApagam('Get-ChildItem D:/Diego/proj -Recurse | Remove-Item -Recurse -Force'), ['D:/Diego/proj'])
  assert.deepEqual(alvosQueApagam('gci D:/Diego/proj | rm -r -fo'), ['D:/Diego/proj'])
})

test('o que já funcionava continua igual', () => {
  assert.deepEqual(alvosQueApagam('rm -rf D:/Diego/projeto'), ['D:/Diego/projeto'])
  assert.deepEqual(alvosQueApagam('echo "rm -rf D:/Diego"'), [])
  assert.deepEqual(alvosQueApagam('rmdir vazia'), [])
  assert.deepEqual(alvosQueApagam('rmdir /s /q pasta'), ['pasta'])
})

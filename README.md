# claude-mods

Mods do Claude Code (function hooks) que uso todo dia. · Claude Code mods (function hooks) I use every day.

[Português](#português) · [English](#english)

---

## Português

Seis mods, cada um resolvendo um problema que apareceu no uso real. A interface e as mensagens dos mods estão em português.

### Instalar

Precisa do Claude Code 2.1.287 ou mais novo.

```
/plugin marketplace add diegocamara89/claude-mods
/plugin install sonnet-por-padrao@claude-mods-diego
```

Troque `sonnet-por-padrao` pelo nome de qualquer mod da tabela. Para testar sem instalar: `claude --plugin-dir ./mods/<nome>`.

### Os mods

| Mod | O que faz | O que acessa |
|---|---|---|
| [sonnet-por-padrao](mods/sonnet-por-padrao) | Subagente e agente de script (Workflow) criados **sem modelo escrito** rodam no Sonnet, em vez de herdar o Opus da conversa. Opus continua valendo quando escrito de propósito. | Reescreve o modelo do subagente e o script do Workflow; grava um registro das decisões (com a descrição de cada subagente) em `LOCALAPPDATA` no Windows ou `TMPDIR`/`/tmp` fora dele. |
| [revisor-com-prova](mods/revisor-com-prova) | Quando volta o resultado de um revisor (Codex, `codex exec`, agy, council), anexa ao resultado um lembrete: achado só vale com prova, reproduza antes de corrigir, "aprovado sem achados" é válido. | Só lê o comando; anexa texto ao resultado, que só o modelo vê. Os padrões `agy.py` e `council.py` são de skills do autor; sem elas, simplesmente não disparam. |
| [proximos-passos](mods/proximos-passos) | Depois de cada resposta, o Haiku propõe três próximos pedidos em botões acima da caixa (teclas 1-3). `/custos` mostra os tokens medidos. | Chama o Haiku (cerca de 1 mil tokens por sugestão, medido); desenha a faixa. |
| [painel-vivo](mods/painel-vivo) | Painel ao vivo, para ler de relance: uma manchete com Pendências, Atividade e Progresso; fila do que pede você (permissão, pergunta, travado) e avisos; trabalhadores em árvore (subagentes, agentes de Workflow, comandos, agy e Codex aninhados em quem os chamou), cada um com tempo, modelo, tokens e o que faz agora; outras sessões em andamento numa linha; cotas de 5 h e 7 dias. "Explicar" traduz um trabalho para leigo e alimenta um glossário (`/glossario`). | Envolve cada comando Bash e PowerShell para copiar a saída num arquivo local (`tee`, em `LOCALAPPDATA` ou `TMPDIR`) e marcar onde o agy grava os passos (`AGY_EVENTS_DIR`); apaga esses arquivos depois de 1 dia; se o [rtk](https://github.com/rtk-ai/rtk) estiver instalado, passa o comando por ele antes; guarda um resumo de cada sessão no armazenamento do plugin para as outras sessões verem; lê o título da conversa no transcript com um script Python curto; chama o Haiku só no "Explicar". |
| [lixeira](mods/lixeira) | Nega o apagar de vez e devolve ao Claude o comando que manda para a lixeira do sistema; barra comandos sem volta (`git reset --hard`, `push --force`, formatar, esvaziar lixeira, desligar ou reiniciar o computador, `Format-Volume`, `Clear-Disk`) até o usuário dizer sim (`LIXEIRA_OK=1` no Bash, `$env:LIXEIRA_OK=1;` no PowerShell). Também pega o apagar pela esteira do PowerShell (`gci pasta \| Remove-Item`). Temporários, caches e arquivos criados na conversa ficam livres. | Lê o comando e nega quando precisa. No Windows usa o `lixeira.ps1` que vem junto; no macOS e no Linux sugere `trash` ou `gio trash`. |
| [varredura-push](mods/varredura-push) | Antes de `git push` e de publicação pelo `gh` (no Bash e no PowerShell), confere os commits que vão subir procurando chave, token e senha. Barra o envio se achar. Liberação pontual com `VARREDURA_OK=1`. | Põe `python varredura.py &&` antes do push. Usa o [gitleaks](https://github.com/gitleaks/gitleaks) se estiver no PATH; sem ele, regras de reserva. |

### Por que o revisor-com-prova

Revisor por LLM tende a achar defeito em trabalho correto quando o pedido manda "achar o que quebra": num estudo de 2026, o GPT-4o reprovou 73% de código correto com esse enquadramento, contra 26% com um pedido simples (arXiv 2603.00539). Do outro lado, quem recebe a crítica aceita sem conferir: diante de 48 relatórios falsos, o Claude Code rejeitou 1 (arXiv 2604.11950). Exigir prova reverteu isso para 85–96% de rejeição. O mod coloca essa regra exatamente onde ela faz falta: no resultado do revisor, e não em toda mensagem.

### Requisitos e limites

- `painel-vivo`: a saída ao vivo usa `bash` (no Windows, o Git Bash que o Claude Code já usa); o nome das outras sessões precisa de `python` no PATH; feito para o app desktop (no terminal, desenha uma versão só texto). O Codex não informa tokens: o painel mostra só o modelo, quando o comando o escolhe.
- `varredura-push`: precisa de Python (`python` no Windows, `python3` no macOS e no Linux).
- `sonnet-por-padrao`: não vê script de Workflow rodado a partir de arquivo (`scriptPath`) nem Workflow salvo por nome.
- `revisor-com-prova`: também dispara quando o agy é usado só para extrair dados; o lembrete começa com "se este resultado traz crítica".

### Créditos

A leitura de comandos da `lixeira` (aspas, `sudo`/`env`, alvos seguros) veio de ideias do [launch-codes](https://github.com/OneWave-AI/claude-code-mods/tree/main/launch-codes), da OneWave AI (MIT).

Licença: [MIT](LICENSE).

---

## English

Six mods, each fixing a problem that came up in real use. The mods' UI and messages are in Portuguese.

### Install

Requires Claude Code 2.1.287 or later.

```
/plugin marketplace add diegocamara89/claude-mods
/plugin install sonnet-por-padrao@claude-mods-diego
```

Replace `sonnet-por-padrao` with any mod name from the table. To try one without installing: `claude --plugin-dir ./mods/<name>`.

### The mods

| Mod | What it does | What it touches |
|---|---|---|
| [sonnet-por-padrao](mods/sonnet-por-padrao) ("Sonnet by default") | Subagents and Workflow script agents created **without an explicit model** run on Sonnet instead of inheriting the session's Opus. An explicit `opus` is kept. | Rewrites the subagent's model and the Workflow script; logs its decisions (with each subagent's description) to `LOCALAPPDATA` on Windows or `TMPDIR`/`/tmp` elsewhere. |
| [revisor-com-prova](mods/revisor-com-prova) ("reviewer with evidence") | When a reviewer returns (Codex, `codex exec`, agy, council), attaches a reminder to the result: a finding counts only with evidence, reproduce before fixing, "approved with no findings" is valid. | Reads the command only; attaches model-only text to the result. The `agy.py` and `council.py` patterns come from the author's own skills; without them they simply never fire. |
| [proximos-passos](mods/proximos-passos) ("next steps") | After each answer, Haiku proposes three next requests as buttons above the prompt (keys 1-3). `/custos` shows measured token use. | Calls Haiku (about 1k tokens per suggestion, measured); draws the band. |
| [painel-vivo](mods/painel-vivo) ("live pane") | Glanceable live pane: a headline with Pending, Activity and Progress; a queue of what needs you (permission, question, stuck worker) and warnings; workers as a tree (subagents, Workflow agents, commands, agy and Codex nested under whoever called them), each with elapsed time, model, tokens and what it is doing now; other busy sessions in one line; 5-hour and 7-day rate limits. "Explicar" explains a job in plain language and feeds a glossary (`/glossario`). | Wraps each Bash and PowerShell command to copy its output to a local file (`tee`, in `LOCALAPPDATA` or `TMPDIR`) and to tell agy where to write its steps (`AGY_EVENTS_DIR`); deletes those files after 1 day; if [rtk](https://github.com/rtk-ai/rtk) is installed, runs the command through it first; keeps a per-session summary in the plugin store so other sessions can see it; reads the conversation title from the transcript with a short Python script; calls Haiku only on "Explicar". |
| [lixeira](mods/lixeira) ("trash") | Denies permanent deletes and hands Claude the command that moves the files to the system trash; blocks no-way-back commands (`git reset --hard`, `push --force`, format, emptying the trash, shutting down or restarting the computer, `Format-Volume`, `Clear-Disk`) until the user says yes (`LIXEIRA_OK=1` in Bash, `$env:LIXEIRA_OK=1;` in PowerShell). It also catches deletes through a PowerShell pipeline (`gci folder \| Remove-Item`). Temp folders, caches and files written in the session stay free. | Reads the command and denies when needed. On Windows it uses the bundled `lixeira.ps1`; on macOS and Linux it suggests `trash` or `gio trash`. |
| [varredura-push](mods/varredura-push) ("push scan") | Before `git push` and `gh` publishing (in Bash and PowerShell), scans the commits about to leave for keys, tokens and passwords, and blocks the push on a hit. One-off override with `VARREDURA_OK=1`. | Prepends `python varredura.py &&` to the push. Uses [gitleaks](https://github.com/gitleaks/gitleaks) when on PATH; fallback rules otherwise. |

### Why revisor-com-prova

LLM reviewers find defects in correct work when told to "find what breaks": in a 2026 study GPT-4o rejected 73% of correct code under that framing, against 26% with a plain prompt (arXiv 2603.00539). On the receiving side, critique gets accepted unchecked: given 48 false reports, Claude Code rejected 1 (arXiv 2604.11950). Requiring evidence moved that to 85–96% rejection. The mod puts the rule exactly where it is needed: on the reviewer's result, not on every message.

### Requirements and limits

- `painel-vivo`: live output uses `bash` (on Windows, the Git Bash Claude Code already uses); other sessions' names need `python` on PATH; built for the desktop app (the terminal gets a text-only version). Codex does not report tokens: the pane shows only its model, when the command picks one.
- `varredura-push`: needs Python (`python` on Windows, `python3` on macOS and Linux).
- `sonnet-por-padrao`: does not see Workflow scripts run from a file (`scriptPath`) or saved Workflows run by name.
- `revisor-com-prova`: also fires when agy is used only for extraction; the reminder starts with "if this result carries critique".

### Credits

The command parsing in `lixeira` (quotes, `sudo`/`env`, safe targets) builds on ideas from [launch-codes](https://github.com/OneWave-AI/claude-code-mods/tree/main/launch-codes) by OneWave AI (MIT).

License: [MIT](LICENSE).

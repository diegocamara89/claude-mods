"""Varredura antes de publicar: procura segredo (chave, token, senha) no que vai subir.

O mod varredura-push insere `python varredura.py [-C pasta] &&` antes de cada git push e
publicação do gh. Roda no momento exato do push, depois do add/commit do mesmo comando.
Sai com 1 (e o push não acontece) se achar algo; 0 se estiver limpo.

Confere só os commits que nenhum remoto tem: é exatamente o que o push vai mandar.
  1. gitleaks (se estiver no PATH): mais de 150 tipos de token e chave.
  2. Sem gitleaks: regras de reserva para os formatos mais comuns.
  3. Sempre: senha ou token escrito em texto (`password = "..."`).

Uso: python varredura.py [-C pasta] [--tudo]
  --tudo confere o histórico inteiro, não só o que vai subir (para calibrar falso positivo).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

GITLEAKS = shutil.which("gitleaks")

# Usadas só se o gitleaks faltar.
TOKENS = [
    ("chave privada", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    ("token do GitHub", r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}"),
    ("chave da OpenAI/Anthropic", r"\bsk-(ant-)?[A-Za-z0-9_-]{20,}"),
    ("chave da AWS", r"\bAKIA[0-9A-Z]{16}\b"),
    ("chave do Google", r"\bAIza[0-9A-Za-z_-]{35}\b"),
    ("token do Slack", r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
]

SEMPRE = [
    ("senha ou token escrito",
     r"(?i)\b(api[_-]?key|token|secret|senha|password|passwd)\b\s*[:=]\s*['\"]"
     r"(?=[^'\"]*\d)(?=[^'\"]*[A-Za-z])[A-Za-z0-9_+/=.:-]{8,}['\"]"),
]


def regras():
    lista = SEMPRE + ([] if GITLEAKS else TOKENS)
    return [(nome, re.compile(padrao)) for nome, padrao in lista]


def git(pasta, *args):
    r = subprocess.run(["git", "-C", pasta, *args], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return r.returncode, r.stdout, r.stderr


def mascara(s):
    return s[0] + "…" if len(s) <= 6 else s[:4] + "…" + s[-2:]


def gitleaks(pasta, faixa):
    if not GITLEAKS:
        return []
    fd, rel = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    try:
        subprocess.run([GITLEAKS, "git", pasta, f"--log-opts={' '.join(faixa)}", "--redact",
                        "--no-banner", "--report-format", "json", "--report-path", rel,
                        "--exit-code", "0", "--log-level", "error"], capture_output=True, timeout=120)
        with open(rel, encoding="utf-8") as f:
            dados = json.load(f) or []
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return ["! gitleaks não conseguiu rodar; segui só com as regras de reserva"]
    finally:
        os.unlink(rel)
    return [f"✕ {d.get('Description') or d.get('RuleID')} em {d.get('File')}:{d.get('StartLine')} (gitleaks)"
            for d in dados]


def main():
    pasta = "."
    if len(sys.argv) >= 3 and sys.argv[1] == "-C":
        pasta = sys.argv[2]
    faixa = ["--all"] if "--tudo" in sys.argv else ["--branches", "--not", "--remotes"]
    rc, log, err = git(pasta, "log", "-p", "--no-color", "--format=commit %h", *faixa)
    if rc != 0:
        print(f"varredura: não consegui ler o repositório em {os.path.abspath(pasta)}: {err.strip()}")
        print("Push barrado. Se o usuário disser que pode subir sem conferir, repita com VARREDURA_OK=1 na frente (Bash) ou $env:VARREDURA_OK=1; na frente (PowerShell).")
        return 1

    achados = gitleaks(pasta, faixa)
    if achados and achados[0].startswith("!"):
        print(achados.pop(0), file=sys.stderr)
    arquivo, linha, linhas = "", 0, 0
    lista = regras()
    for l in log.split("\n"):
        if l.startswith("+++ "):
            arquivo = l[6:]
            continue
        h = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)", l)
        if h:
            linha = int(h.group(1))
            continue
        if l.startswith("+"):
            linhas += 1
            for nome, rx in lista:
                m = rx.search(l[1:])
                if m:
                    item = f"✕ {nome} em {arquivo}:{linha} → \"{mascara(m.group(0))}\""
                    if item not in achados:
                        achados.append(item)
            linha += 1
        elif not l.startswith("-"):
            linha += 1

    if not achados:
        extra = "" if GITLEAKS else " (sem gitleaks no PATH: só as regras de reserva)"
        print(f"varredura: {linhas} linhas novas conferidas, nada sensível{extra}.", file=sys.stderr)
        return 0
    print(f"varredura-push barrou a publicação: {len(achados)} achado(s) nas {linhas} linhas que vão subir.")
    for a in achados[:15]:
        print(a)
    if len(achados) > 15:
        print(f"… e mais {len(achados) - 15}.")
    print("Mostre os achados ao usuário. Se forem falso positivo e ele disser que pode subir, "
          "repita o comando com VARREDURA_OK=1 na frente (Bash) ou $env:VARREDURA_OK=1; na frente (PowerShell). Nunca use isso por conta própria.")
    return 1


if __name__ == "__main__":
    sys.exit(main())

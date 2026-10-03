#!/usr/bin/env python3
"""One-time ($0) production setup for MerchantBridge. Run it yourself from the repo root:

    python3 scripts/setup-deploy.py                 # first run
    python3 scripts/setup-deploy.py --web-url URL   # after the Vercel project exists (sets CORS + links)
    python3 scripts/setup-deploy.py --zoho          # after the Zoho API-console PROD client exists

What it does, with no secret ever printed or written to disk:
  1. Neon: logs the Neon CLI in through your browser (one click), reads the pooled + direct connection strings of the
     project and runs the database migrations.
  2. Asks (hidden input) for the Upstash Redis URL, the Groq API key and a Hugging Face write token.
  3. Creates the public Docker Space <hf-user>/merchantbridge-api if missing and sets its secrets and variables;
     generates MB_ENCRYPTION_KEY / MB_STATE_SECRET / MB_CONNECT_INVITE_CODE only if the Space does not have them yet
     (re-running never rotates them, so stored Zoho tokens stay decryptable).
  4. GitHub (gh, already logged in): secret HF_TOKEN and variables HF_SPACE / API_URL / WEB_URL, then runs the
     "Deploy API (Hugging Face Space)" workflow and waits for /health/ready.
Needs: python3, pnpm, gh (logged in as the repo owner), git. Everything used is on a free tier.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

REPO = "jayasinghthakur/merchantbridge"
DEFAULT_NEON_PROJECT = "rough-resonance-29665077"
DEFAULT_SPACE_NAME = "merchantbridge-api"
NEONCTL = ["pnpm", "dlx", "neonctl@8.0.4"]
HF_API = "https://huggingface.co/api"
GROQ_BASE_URL = "https://api.groq.com/openai/v1"
DEFAULT_MODEL = "llama-3.3-70b-versatile"


def say(msg: str) -> None:
    print(f"==> {msg}", flush=True)


def die(msg: str) -> None:
    print(f"\nERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


def run(cmd: list[str], *, env: dict[str, str] | None = None, capture: bool = False, stdin: str | None = None) -> str:
    """Runs a command; never echoes its output when capture=True (it may hold a secret)."""
    try:
        res = subprocess.run(
            cmd,
            env={**os.environ, **(env or {})},
            input=stdin,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
            check=False,
        )
    except FileNotFoundError:
        die(f"'{cmd[0]}' is not installed or not on PATH.")
    if res.returncode != 0:
        detail = ""
        if capture and res.stderr:
            # stderr of these tools carries no secrets; show the tail for diagnosis.
            detail = "\n" + "\n".join(res.stderr.strip().splitlines()[-5:])
        die(f"command failed ({res.returncode}): {' '.join(cmd[:3])} ...{detail}")
    return (res.stdout or "").strip() if capture else ""


def ask_secret(label: str, pattern: str | None = None, hint: str = "") -> str:
    while True:
        value = getpass.getpass(f"    {label}{(' (' + hint + ')') if hint else ''}: ").strip()
        if not value:
            print("    (empty — try again)")
            continue
        if pattern and not re.match(pattern, value):
            print("    (that does not look right — check you copied the whole value)")
            continue
        return value


def hf_request(method: str, path: str, token: str, body: dict | None = None) -> tuple[int, dict | list | None]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{HF_API}{path}",
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read().decode() or "null"
            return res.status, json.loads(raw)
    except urllib.error.HTTPError as err:
        raw = err.read().decode(errors="replace")
        try:
            return err.code, json.loads(raw)
        except json.JSONDecodeError:
            return err.code, {"error": raw[:200]}


def space_host(owner: str, name: str) -> str:
    def norm(s: str) -> str:
        return re.sub(r"[^a-z0-9-]", "-", s.lower())

    return f"https://{norm(owner)}-{norm(name)}.hf.space"


def neon_strings(project_id: str) -> tuple[str, str]:
    say("Neon: checking CLI login (a browser tab opens for one click if needed)")
    probe = subprocess.run([*NEONCTL, "me", "--output", "json"], text=True, capture_output=True)
    if probe.returncode != 0:
        run([*NEONCTL, "auth"])
    pooled = run([*NEONCTL, "connection-string", "--project-id", project_id, "--pooled", "--ssl", "require"], capture=True)
    direct = run([*NEONCTL, "connection-string", "--project-id", project_id, "--ssl", "require"], capture=True)
    for s in (pooled, direct):
        if not s.startswith("postgres"):
            die("Neon did not return a Postgres connection string; check the project id.")
    say("Neon: got the pooled and direct connection strings (not shown)")
    return pooled, direct


def run_migrations(direct_url: str) -> None:
    say("Neon: running database migrations")
    run(["pnpm", "--filter", "@mb/api", "exec", "tsx", "scripts/migrate.ts"], env={"DATABASE_URL_UNPOOLED": direct_url, "DATABASE_URL": direct_url})
    say("Neon: migrations applied")


def ensure_space(token: str, owner: str, name: str) -> None:
    status, _ = hf_request("GET", f"/spaces/{owner}/{name}", token)
    if status == 200:
        say(f"Hugging Face: Space {owner}/{name} exists")
        return
    say(f"Hugging Face: creating public Docker Space {owner}/{name}")
    status, body = hf_request(
        "POST",
        "/repos/create",
        token,
        {"type": "space", "name": name, "sdk": "docker", "private": False, "short_description": "MerchantBridge API (MCP connector for Zoho Inventory)"},
    )
    if status not in (200, 201, 409):
        die(f"could not create the Space (HTTP {status}): {json.dumps(body)[:200]}")


def existing_keys(token: str, owner: str, name: str, kind: str) -> set[str]:
    status, body = hf_request("GET", f"/spaces/{owner}/{name}/{kind}", token)
    if status != 200:
        return set()
    if isinstance(body, dict):
        return set(body.keys())
    if isinstance(body, list):
        return {item.get("key") for item in body if isinstance(item, dict)}
    return set()


def set_space(token: str, owner: str, name: str, kind: str, key: str, value: str) -> None:
    status, body = hf_request("POST", f"/spaces/{owner}/{name}/{kind}", token, {"key": key, "value": value})
    if status not in (200, 201):
        die(f"could not set Space {kind[:-1]} {key} (HTTP {status}): {json.dumps(body)[:160]}")


def gh(*args: str, stdin: str | None = None) -> str:
    return run(["gh", *args], capture=True, stdin=stdin)


def wait_healthy(api_url: str, minutes: int = 20) -> bool:
    deadline = time.time() + minutes * 60
    last = ""
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{api_url}/health/ready", timeout=15) as res:
                body = res.read().decode()
                if res.status == 200:
                    say(f"API is up: {body[:160]}")
                    return True
        except Exception as err:  # noqa: BLE001 — any failure just means "not up yet"
            last = type(err).__name__
        print(f"    waiting for {api_url} ... ({last or 'starting'})", flush=True)
        time.sleep(30)
    return False


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--neon-project", default=DEFAULT_NEON_PROJECT)
    p.add_argument("--space-name", default=DEFAULT_SPACE_NAME)
    p.add_argument("--web-url", default="", help="Vercel production URL, e.g. https://merchantbridge.vercel.app")
    p.add_argument("--zoho", action="store_true", help="also set the Zoho PROD client id/secret (enables /connect)")
    p.add_argument("--skip-neon", action="store_true", help="keep the Space's existing DATABASE_URL")
    p.add_argument("--skip-deploy", action="store_true", help="do not trigger the deploy workflow")
    args = p.parse_args()

    # pnpm (via corepack) and gh were installed into ~/.local/bin, which a plain Terminal PATH may not include.
    local_bin = os.path.expanduser("~/.local/bin")
    if os.path.isdir(local_bin) and local_bin not in os.environ.get("PATH", "").split(os.pathsep):
        os.environ["PATH"] = local_bin + os.pathsep + os.environ.get("PATH", "")

    for tool in ("pnpm", "gh", "git"):
        if not shutil.which(tool):
            die(f"'{tool}' is required on PATH")
    if "jayasinghthakur" not in run(["gh", "api", "user", "--jq", ".login"], capture=True):
        die("gh is not logged in as jayasinghthakur (run: gh auth switch -u jayasinghthakur)")

    print("\nMerchantBridge $0 setup. Secrets are read with hidden input and never printed or saved.\n")
    say("Hugging Face write token (huggingface.co → Settings → Access Tokens → New token, type Write)")
    hf_token = ask_secret("Hugging Face token", r"^hf_[A-Za-z0-9]{20,}$", "starts with hf_")
    status, who = hf_request("GET", "/whoami-v2", hf_token)
    if status != 200 or not isinstance(who, dict) or not who.get("name"):
        die("Hugging Face rejected the token (needs Write access)")
    owner = str(who["name"])
    name = args.space_name
    api_url = space_host(owner, name)
    say(f"Hugging Face user: {owner} → API URL will be {api_url}")

    ensure_space(hf_token, owner, name)
    have_secrets = existing_keys(hf_token, owner, name, "secrets")

    space_secrets: dict[str, str] = {}
    if not args.skip_neon:
        pooled, direct = neon_strings(args.neon_project)
        run_migrations(direct)
        space_secrets["DATABASE_URL"] = pooled
        space_secrets["DATABASE_URL_UNPOOLED"] = direct

    if "REDIS_URL" not in have_secrets or not args.skip_neon:
        say("Upstash: Redis URL (console.upstash.com → your database → Connect → ioredis; starts with rediss://)")
        space_secrets["REDIS_URL"] = ask_secret("Upstash Redis URL", r"^rediss://", "rediss://default:…@…:6379")
    if "MB_LLM_API_KEY" not in have_secrets or not args.skip_neon:
        say("Groq: API key (console.groq.com → API Keys)")
        space_secrets["MB_LLM_API_KEY"] = ask_secret("Groq API key", r"^gsk_", "starts with gsk_")

    invite_code = None
    if "MB_ENCRYPTION_KEY" not in have_secrets:
        space_secrets["MB_ENCRYPTION_KEY"] = base64.b64encode(secrets.token_bytes(32)).decode()
    if "MB_STATE_SECRET" not in have_secrets:
        space_secrets["MB_STATE_SECRET"] = base64.b64encode(secrets.token_bytes(48)).decode()
    if "MB_CONNECT_INVITE_CODE" not in have_secrets:
        invite_code = "mb-" + secrets.token_hex(4)
        space_secrets["MB_CONNECT_INVITE_CODE"] = invite_code

    if args.zoho:
        say("Zoho: PROD server-based client from api-console.zoho.in (redirect URI must be the one printed below)")
        print(f"    Redirect URI to register in Zoho: {api_url}/oauth/zoho/callback")
        space_secrets["ZOHO_CLIENT_ID"] = ask_secret("Zoho Client ID", r"^1000\.", "starts with 1000.")
        space_secrets["ZOHO_CLIENT_SECRET"] = ask_secret("Zoho Client Secret")

    web_url = args.web_url.rstrip("/")
    variables = {
        "NODE_ENV": "production",
        "PORT": "8787",
        "MB_PUBLIC_API_URL": api_url,
        "MB_CLIENT_IP_SOURCE": "xff-last",
        "MB_LLM_PROVIDER": "openai",
        "MB_LLM_BASE_URL": GROQ_BASE_URL,
        "MB_PLAYGROUND_MODEL": DEFAULT_MODEL,
        "MB_PLAYGROUND_ENABLED": "true",
        # Groq's free tier allows roughly 100K tokens/day on the 70B model; keep public questions well under it.
        "MB_PLAYGROUND_DAILY_CAP": "40",
        "ZOHO_REDIRECT_URI": f"{api_url}/oauth/zoho/callback",
    }
    if web_url:
        variables["MB_PUBLIC_WEB_URL"] = web_url
        variables["MB_CORS_ORIGINS"] = web_url

    say(f"Hugging Face: setting {len(space_secrets)} secrets and {len(variables)} variables on {owner}/{name}")
    for key, value in space_secrets.items():
        set_space(hf_token, owner, name, "secrets", key, value)
    for key, value in variables.items():
        set_space(hf_token, owner, name, "variables", key, value)

    say("GitHub: setting secret HF_TOKEN and variables HF_SPACE / API_URL" + (" / WEB_URL" if web_url else ""))
    gh("secret", "set", "HF_TOKEN", "--repo", REPO, stdin=hf_token)
    gh("variable", "set", "HF_SPACE", "--repo", REPO, "--body", f"{owner}/{name}")
    gh("variable", "set", "API_URL", "--repo", REPO, "--body", api_url)
    if web_url:
        gh("variable", "set", "WEB_URL", "--repo", REPO, "--body", web_url)

    if not args.skip_deploy:
        say("GitHub: running the 'Deploy API (Hugging Face Space)' workflow (first build takes a few minutes)")
        gh("workflow", "run", "deploy-hf-space.yml", "--repo", REPO, "--ref", "main")
        time.sleep(10)
        if not wait_healthy(api_url):
            say("Not healthy yet. Check the Space build logs at https://huggingface.co/spaces/" + f"{owner}/{name}")

    print("\nDone. Summary (no secrets):")
    print(f"  API:            {api_url}")
    print(f"  Public MCP:     {api_url}/mcp/demo")
    print(f"  Space:          https://huggingface.co/spaces/{owner}/{name}")
    if invite_code:
        print(f"  Connect invite: {invite_code}   (needed at /connect; keep it for the submission email)")
    if not web_url:
        print("\n  Next: import the GitHub repo in Vercel (Root Directory apps/web, env NEXT_PUBLIC_API_URL="
              f"{api_url}), then re-run with --skip-neon --web-url <your vercel url>.")
    if not args.zoho:
        print("  Later: after creating the Zoho PROD client, re-run with --skip-neon --zoho.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        die("cancelled")

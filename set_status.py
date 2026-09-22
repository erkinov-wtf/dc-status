#!/usr/bin/env python3
"""Set your Discord custom status bubble.

Edit STATUS below, then run:  python3 set_status.py
"""
import json
import pathlib
import sys
import urllib.error
import urllib.request

STATUS = ""   # <-- change this to whatever you want; "" clears the status
EMOJI = ""           # optional unicode emoji shown before the text, e.g. "📚"


def load_token() -> str:
    env = pathlib.Path(__file__).with_name(".env")
    if not env.exists():
        sys.exit(
            "No .env file found.\n"
            "Create one next to this script containing:\n"
            "DISCORD_TOKEN=your_token_here"
        )
    for line in env.read_text().splitlines():
        if line.startswith("DISCORD_TOKEN="):
            return line.split("=", 1)[1].strip().strip("\"'")
    sys.exit("DISCORD_TOKEN not found in .env")


def main() -> None:
    token = load_token()

    custom = None
    if STATUS or EMOJI:
        custom = {"text": STATUS or None}
        if EMOJI:
            custom["emoji_name"] = EMOJI

    req = urllib.request.Request(
        "https://discord.com/api/v9/users/@me/settings",
        data=json.dumps({"custom_status": custom}).encode(),
        method="PATCH",
        headers={
            "Authorization": token,
            "Content-Type": "application/json",
            # Discord rejects requests with no browser-looking user agent
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        if e.code == 401:
            sys.exit("✗ Discord says the token is invalid (401). Re-copy it into .env")
        sys.exit(f"✗ Discord returned {e.code}: {detail}")

    if custom:
        print(f"✓ custom status set to: {EMOJI + ' ' if EMOJI else ''}{STATUS}")
    else:
        print("✓ custom status cleared")


if __name__ == "__main__":
    main()

"""One-time helper: turn a Zoho Self Client code into a refresh token.

Run:  python get_refresh_token.py
It asks for the values (nothing is stored in this file).
"""
import getpass

import requests

TOKEN_URL = "https://accounts.zoho.in/oauth/v2/token"  # India data centre

client_id = input("Client ID: ").strip()
client_secret = getpass.getpass("Client Secret (hidden while typing): ").strip()
code = input("Code from the Generate Code tab: ").strip()

resp = requests.post(
    TOKEN_URL,
    data={
        "grant_type": "authorization_code",
        "client_id": client_id,
        "client_secret": client_secret,
        "code": code,
    },
    timeout=30,
)
print("HTTP", resp.status_code)
data = resp.json()
if "refresh_token" in data:
    print("\nREFRESH TOKEN (save this somewhere private):")
    print(data["refresh_token"])
else:
    print(data)

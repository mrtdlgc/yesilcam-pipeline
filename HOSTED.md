# Hosted accounts and bring your own keys

Set `APP_MODE=hosted` to offer separate accounts. Leave it as `personal` (the default) for the
existing password-protected workspace and its server Codex login. Use a separate persistent data
volume for the public service; personal jobs and credentials are never assigned to the first person
who signs up.

## Deployment

Use Node 22.13 or later (the Docker image uses Node 24), one server process, and a persistent
`/data` volume. The existing volume lock prevents competing queue writers. Accounts use Node's
SQLite implementation; no external database service or native npm database addon is needed.

```dotenv
APP_MODE=hosted
PUBLIC_ORIGIN=https://subtitles.example.com
DATA_DIR=/data
SIGNUP_ENABLED=true
MAX_ACCOUNTS=1000
SCANNER_ENABLED=false
TRANSCRIBE_BACKEND=elevenlabs
KEEP_INTERMEDIATES=false
CHATGPT_PLAN_USAGE_ENABLED=false
SOURCE_URL=https://github.com/mrtdlgc/yesilcam-pipeline
```

`APP_PASSWORD` is used only in personal mode. Configure your HTTPS proxy and `TRUSTED_PROXIES`
explicitly; don't trust arbitrary forwarding headers. The hosted service disables server library
controls, local Whisper and arbitrary transcription URLs. Jobs run one at a time with a global queue
cap and at most three waiting/running jobs per user. A user's failed job does not pause everyone
else's queue. Storage and upload limits still apply.

People register with email, username and a password of at least 12 characters. They can sign in with
either email or username. A high-entropy recovery code is shown once at registration; recovery
rotates that code and revokes all sessions. **Email addresses are not verified and no email is
sent.** Save the recovery code in a password manager. SMTP-based verification and recovery are not
implemented; do not describe the address as verified or use it for trusted identity linking.

Sessions expire after 12 hours, use HttpOnly cookies, and survive server restarts. Password changes
and recovery revoke every session for that account. Authentication routes have bounded concurrency
and IP rate limits. Set `SIGNUP_ENABLED=false` to close registrations without disabling sign-in.

## Provider connections

- **Default: this session.** Keys are held encrypted in server memory, tied to the current account
  session. They disappear on logout, expiry (at most 12 hours), or restart. Closing a tab does not
  immediately log out. Reconnect before resuming queued jobs if the key expired.
- **Optional: remember.** AES-256-GCM encrypts the value before it enters SQLite, with the user ID
  and field name authenticated as associated data. Clear disconnects it across that user's sessions.
- Passwords use salted scrypt hashes. Session tokens and recovery codes are hashed. Provider keys
  cannot be hashed because the actual credential is needed to authenticate outgoing requests.
- Neither API keys nor OAuth tokens are written to browser storage, returned by connection-status
  APIs, or included in job settings. Status means saved, not validated with the provider.
- Hosted users never inherit environment keys, the personal vault, or the owner's Codex allowance.
  There is no automatic switch from a subscription to API billing.

Direct ElevenLabs is the default transcription provider. Other built-in cloud transcription adapters
remain available with each user's keys. Translation offers OpenAI Responses using the user's API key
and model selection (default `gpt-5.4`). Translation API charges are separate from ASR estimates and
from ChatGPT subscriptions; set provider-side spending limits. Whole-file translation, validation,
editorial cues, song handling, reusable receipts and manual corrections use the same pipeline as
personal Codex translation.

Local movies continue through the hybrid browser workflow: extract embedded subtitles or compact
audio locally; transfer only required material. Playback, waveforms and optional compatible
screening copies remain local. Hosted job files, output downloads and correction documents are
restricted to their account. Edits never start a paid translation.

## ChatGPT subscription OAuth: prepared, disabled by default

OpenAI's current
[Sign in with ChatGPT documentation](https://developers.openai.com/siwc/token-sharing-open-source)
distinguishes local/self-hosted open-source tools from remotely hosted services. Open-sourcing this
repository does not itself grant permission for a public hosted service to consume subscribers' plan
allowances. Request approval through OpenAI's interest form. Other vendors' subscription tokens are
not accepted as API keys or treated as authorized OAuth integrations.

After OpenAI approves this specific hosted use and supplies the necessary grant:

1. Register the exact callback `https://YOUR_ORIGIN/BASE_PATH/api/oauth/chatgpt/callback` (omit
   `BASE_PATH` when unused).
2. Configure `CHATGPT_OAUTH_CLIENT_ID`, and `CHATGPT_OAUTH_CLIENT_SECRET` if your registered client
   uses `client_secret_basic`. The secret stays in server configuration. Public clients omit it.
3. Set `CHATGPT_PLAN_USAGE_ENABLED=true` only when the approved client supports
   `offline_access resource.invoke chatgpt.tokens.use.direct` alongside OIDC identity scopes.
4. Complete a live consent, renewal, inference and revocation acceptance check with that approved
   client before advertising subscription access. The prepared implementation uses OpenAI's
   documented discovery, PKCE, nonce, JWT/JWKS validation, session-bound one-use state and
   serialized refresh. It checks granted plan scope and never automatically links local accounts by
   email.

The host does not reuse the Codex CLI's OAuth client or ask people to export subscription tokens.
The local/personal installation retains its existing supported `codex login` workflow. Without
approval, the hosted interface explicitly says that ChatGPT subscription connections await
activation; API BYOK remains available.

## Persistence and backup

| Location under `DATA_DIR`                                   | Contents                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `data/private/accounts.sqlite` (plus WAL/SHM while running) | Accounts, password/recovery/session hashes, encrypted remembered connections |
| `data/private/master.key`                                   | Local vault encryption key, unless supplied through `CREDENTIALS_MASTER_KEY` |
| `data/processing-queue.json` and `data/job-logs/`           | Queue ownership, progress and bounded logs                                   |
| `accounts/USER_ID/`                                         | Private inputs, subtitles, receipts, screening metadata and corrections      |

Stop the service cleanly before filesystem backups, or use SQLite's supported online backup
mechanism. Back up the vault key separately and protect both backups. A lost key is never silently
replaced for an existing database. Encryption protects database-only disclosure; someone operating
the server can access keys while they are used. Don't claim end-to-end encryption.

## License and source access

The project is **AGPL-3.0-only**, with the full text in [LICENSE](LICENSE). If you modify and host
it, offer the corresponding source of your running version to its network users under the AGPL. Set
`SOURCE_URL` to that source; the sign-in page and app provide a visible source link. Keep it public
and include deployment/build instructions and your modifications. Film files, provider keys and
private account data are not part of that source offer.

Third-party components retain their own licenses. The browser FFmpeg engine remains unmodified; its
notices and corresponding upstream source links are in `public/media-tools.html` and
`public/licenses/`. Previously granted licenses to earlier copies are not revoked by this change.

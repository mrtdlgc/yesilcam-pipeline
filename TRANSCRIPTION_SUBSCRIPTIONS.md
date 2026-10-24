# Subscriptions and transcription — checked 2026-10-23

The useful distinction is whether a subscription funds the documented API used by this pipeline. A
web-app upload allowance alone is not an API credential. No plan has been purchased, account linked,
login token read, or paid request made here.

## ElevenLabs: direct API with pay-as-you-go or a plan

The official API pricing page lists Scribe v2 at USD 0.22 per audio hour and offers both
pay-as-you-go and subscription billing. That is approximately USD 0.33 for 90 minutes or USD 0.44
for two hours, before taxes, plan fees and optional features. Included usage and the account's
remaining balance must be checked in the ElevenLabs dashboard; the app does not assume unlimited or
free API use.

Save a normal ElevenLabs API key in Connections. Full-movie Scribe uses the documented API, with
speaker diarization and word timestamps. No browser OAuth or separate subscription endpoint is
needed. OpenRouter credits do not transfer to this direct account. Keyterm prompting, entity
processing, transcript editing and role detection are not enabled by the adapter.

[Official API pricing](https://elevenlabs.io/pricing/api) · [Full-movie setup](FULL_MOVIE_SCRIBE.md)

## Google AI Pro / Ultra: confirmed eligible Cloud-credit route

Google AI Pro includes USD 10/month of GenAI/Cloud developer credits. The current Developer Program
comparison lists USD 40/month for AI Ultra 20 TB and USD 100/month for AI Ultra 30 TB. Activate the
benefit on the eligible developer profile and redeem/link it to the billing account for the Gemini
API project. Family members do not inherit the developer benefit automatically.

The Gemini adapter still uses GEMINI_API_KEY; eligible credits offset the API bill. This is distinct
from the larger AI Studio UI quota and from Google One AI credits. The AI Studio subscription quota
is UI-only. For a prepay account, Google requires a positive paid balance for promotional Cloud
credits to apply. The Gemini API also lists a free tier for Gemini 3.5 Transcribe, subject to its
quota and different data-use terms; no free-tier allowance is assumed in costs.

At the documented approximate USD 0.0051/minute token-based rate, USD 10 covers roughly 1,960
minutes (32.7 hours) if all that credit is available and eligible. This is arithmetic for planning,
not a guarantee of available quota or billing. The subscription fee and other Cloud usage are
additional considerations.

Sources:

- [Official reference](https://developers.google.com/program/plans-and-pricing)
- [Official reference](https://ai.google.dev/gemini-api/docs/google-ai-plans)
- [Official reference](https://developers.google.com/profile/help/faq)
- [Official reference](https://support.google.com/googleone/answer/14534406)
- [Official reference](https://ai.google.dev/gemini-api/docs/pricing)

## Mistral Pro: advertised API credits, confirm the specific account benefit

The current Mistral pricing page advertises API credits on Pro offers. The page renders different
amounts for plan/education/locale variants, so this repository does not hard-code a monthly
allowance as universally available. Confirm the amount and eligibility shown in your own
subscription and Studio credit balance. If those are API credits usable by your Studio organization,
the ordinary Mistral adapter can consume them through MISTRAL_API_KEY.

Do not confuse these with Vibe coding-plan keys. Mistral's API limits help page explicitly tells API
automation users to use an API key from the console, not a plan key created under Code > Vibe Code
CLI. Its coding budget and API rate tiers are different. Check the account credit terms before
assuming a coding allowance pays for Voxtral transcription. Credits do not remove rate limits.

Sources:

- [Official reference](https://mistral.ai/pricing/)
- [Official reference](https://help.mistral.ai/en/articles/698531-why-am-i-hitting-api-rate-limits-and-how-do-i-increase-them)

## Grok / SuperGrok / The X Subscription: promising, endpoint coverage unconfirmed

Grok's current FAQ describes a shared weekly subscription allowance and shows API among the usage
categories. It would be wrong to state categorically that all Grok API usage is always separate from
subscriptions. However, that FAQ does not specify how an API team/key's REST /v1/stt calls map onto
a subscription seat, or guarantee coverage for grok-voice-transcribe-2.0. The newer X Subscription
documentation also describes eligible first-party surfaces, not an unlimited general transcription
API entitlement.

The xai adapter uses the documented XAI_API_KEY endpoint. Its gross REST rate is USD 0.10/hour.
Before classifying its calls as included, verify that your API team/key is linked to the right
subscription and that a small manual request draws down the included pool rather than separate paid
credits. Check any top-up settings. Until that is established, the app records the normal API
estimate. No unofficial app session token, browser scraping or cookie-based API route is
implemented. OpenRouter's xAI route consumes OpenRouter credits, not your Grok subscription.

Sources:

- [Official reference](https://docs.x.ai/grok/faq)
- [Official reference](https://docs.x.ai/x-subscription/usage-limits)
- [Official reference](https://docs.x.ai/developers/models/speech-to-text)
- [Official reference](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text)

## ChatGPT Plus / Pro: no documented subscription path for this transcription API

ChatGPT plan usage and ordinary OpenAI API billing are separate. The new official Sign in with
ChatGPT flow can fund eligible Responses API requests in local and open-source apps, so a blanket
claim that subscriptions can never power an app would also be wrong. Its documented inference
endpoint is /v1/responses; this does not establish access to /v1/audio/transcriptions or the
gpt-transcribe model. The OpenAI transcription adapter therefore requires OPENAI_API_KEY and records
API usage at the published rate. ChatGPT sign-in is not added as a pretend STT credential. A
supported transcription UI can still be compared via manual import.

Sources:

- [Official reference](https://developers.openai.com/siwc/quickstart)
- [Official reference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Official reference](https://learn.chatgpt.com/docs/pricing)
- [Official reference](https://developers.openai.com/api/docs/guides/speech-to-text)

## Other implemented providers

OpenRouter uses purchased credits and can expose BYOK routing; it does not import ChatGPT, Grok,
Mistral or ElevenLabs subscription allowances. Deepgram, AssemblyAI, Speechmatics and Gladia offer
API billing, free evaluation credits or negotiated plans. An account-specific prepaid/committed
balance is not an unlimited consumer subscription. The app supports quoted rates and retains usage
so these plans can be reconciled, but it does not claim a subscription benefit that was not
verified.

For comparison only, matrix rows can include:

```json
{
  "billingScenario": {
    "currency": "USD",
    "remainingCredit": 10,
    "monthlyFee": 19.99
  }
}
```

The tool shows estimated additional usage and the cost if buying that subscription for the run.
These are user-entered assumptions for independent alternatives, not live account balances or an
automatic shared-credit allocator. The gross usage ledger always remains intact. Buying a whole new
subscription solely for a few films may cost more than the API requests; use your actual expected
volume.

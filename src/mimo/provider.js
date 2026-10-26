/**
 * MiMo desktop-app channel: credential discovery, model roster, quota, adapter.
 *
 * The credential and session machinery is vendored from `dsh-mimo-connect`
 * (MIT, © anze225-max) — see `LICENSE` beside this file. What is *not* vendored
 * is its adapter: that one subclasses the host's pi-ai adapter, and this plugin
 * registers structural adapters instead (no version-pinned base class), so the
 * streaming half below is our own and reuses this plugin's SSE reader.
 *
 * Wire facts that matter (measured by the upstream project on 2026-10-12):
 *   - inference goes to `POST /api/route/chat/completions` and authenticates on
 *     the `Cookie` header, not on a bearer token;
 *   - the passport cookies read off the desktop app are exchanged for a
 *     short-lived `serviceToken` through a redirect chain (10 minute TTL);
 *   - remaining allowance is `GET /api/user/usage`.
 *
 * @module src/mimo/provider.js
 */

import { MiMoCredentialStore } from './credential.js'
import { MiMoCatalog, MIMO_DISPLAY_NAME, MIMO_PROVIDER, describeModel, displayNameOf } from './catalog.js'
import { MiMoSession } from './session.js'
import { MiMoQuotaReader } from './quota.js'
import { createChannel } from '../channel.js'
import { readSse } from '../http.js'
import { readStream } from '../stream.js'
import { toChatMessages } from '../messages.js'

export { MIMO_DISPLAY_NAME, MIMO_PROVIDER }

/** Ceiling the upstream project settled on; larger values are refused upstream. */
const DEFAULT_MAX_TOKENS = 65536

/**
 * Model rows this provider advertises, in the shape `registerAdapter` validates.
 *
 * @param provider - the route being listed.
 * @param models - catalog entries.
 */
function toModelRows(provider, models) {
  return models.map(entry => ({
    provider,
    id: entry.id,
    name: displayNameOf(entry),
    description: entry.supportsImages === true ? '小米 MiMo · 桌面端额度 · 支持图片' : '小米 MiMo · 桌面端额度',
    inputModalities: entry.supportsImages === true ? ['text', 'image'] : ['text'],
  }))
}

/**
 * Build the MiMo channel.
 *
 * Nothing here touches the network until something asks for it: the credential
 * store only reads files, and the roster starts as the built-in snapshot so the
 * provider can register on a machine that has never signed in.
 *
 * @param options - dependencies.
 * @param options.logger - logger (defaults to console).
 * @param options.onTopology - called when the roster or sign-in state changed.
 * @returns the runtime: `{ adapter, status, quota, dispose }`.
 */
export function createMiMo({ logger = console, onTopology = () => {} } = {}) {
  const store = new MiMoCredentialStore({})
  const catalog = new MiMoCatalog()
  let session = new MiMoSession({})
  let identity
  let rosterFor
  let disposed = false

  const quota = new MiMoQuotaReader({ getSession: () => session })

  /**
   * Point the session at whatever credential is in effect now.
   *
   * A changed identity (or a jar that lost its passport cookie after the server
   * revoked it with `passToken=EXPIRED`) needs a fresh jar; otherwise the held
   * session keeps its minted token.
   *
   * @returns the credential, or undefined when signed out.
   */
  async function adopt() {
    if (disposed) return undefined
    const status = await store.status()
    if (status.signedIn !== true) {
      if (identity !== undefined) {
        identity = undefined
        rosterFor = undefined
        session = new MiMoSession({})
        quota.invalidate()
        onTopology()
      }
      return undefined
    }
    const next = store.identityOf(status.credential)
    if (next !== identity) {
      identity = next
      rosterFor = undefined
      session = new MiMoSession({ jar: MiMoCredentialStore.jarFor(status.credential) })
      quota.invalidate()
      onTopology()
      return status.credential
    }
    if (!session.hasPassport()) {
      session = new MiMoSession({ jar: MiMoCredentialStore.jarFor(status.credential) })
      quota.invalidate()
    }
    return status.credential
  }

  /**
   * Refresh the roster from the gateway once per signed-in identity.
   *
   * A failure is not an error: the built-in snapshot stays in effect and the
   * model list keeps working.
   */
  async function refreshRoster(signal) {
    if (identity === undefined || identity === rosterFor) return
    try {
      const adopted = await catalog.refreshFromGateway(session, { signal })
      if (adopted === true) {
        rosterFor = identity
        onTopology()
      }
    } catch (error) {
      logger.warn?.(`get-it-for-free: MiMo 模型目录刷新失败：${error?.message ?? error}`)
    }
  }

  /** One streamed turn against the MiMo gateway. */
  async function* stream(options, modelId) {
    const credential = await adopt()
    if (credential === undefined) {
      throw new Error('MiMo 尚未登录：请先登录小米 MiMo 桌面端，或把 passToken 写进 ~/.dsh/.mimo-connect-auth.json')
    }
    await session.ensureSession()
    await refreshRoster(options?.signal)

    const budget = Number.isSafeInteger(options?.maxTokens) && options.maxTokens > 0 ? options.maxTokens : DEFAULT_MAX_TOKENS
    const body = JSON.stringify({
      model: modelId,
      messages: toChatMessages(options?.messages, undefined, []),
      stream: true,
      max_tokens: budget,
    })

    const response = await session.chatStream(body, options?.signal)
    if (!response.ok) {
      let detail = ''
      try {
        detail = (await response.text()).slice(0, 400)
      } catch { /* body already gone */ }
      throw new Error(`MiMo 拒绝了这个请求：HTTP ${response.status}${detail === '' ? '' : ` · ${detail}`}`)
    }

    const channel = createChannel()
    void readSse(response.body, payload => channel.push(payload), options?.signal)
      .then(() => channel.push(undefined))
      .catch(error => channel.push(error instanceof Error ? error : new Error(String(error))))

    yield* readStream(channel.read(), 'chat', new Map(), () => Date.now(), {})
  }

  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: MIMO_DISPLAY_NAME }
    },

    // The harness calls these three without optional guards: `prepareRoutes()`
    // reads `providerRetryPolicy` while registering, image dispatch calls
    // `imageRequestTarget`, and the token meter calls `imageRequestPricing`.
    // Missing members throw a TypeError there, the route never mounts and the
    // settings card says the lane is not attached.
    providerRetryPolicy() {
      return undefined
    },

    imageRequestPricing() {
      return undefined
    },

    imageRequestTarget(provider, model, image) {
      return { width: image.width, height: image.height }
    },

    async listModels(provider) {
      // No credential means no usable models: an empty list keeps the group out
      // of the picker entirely instead of offering rows that cannot answer.
      const credential = await adopt()
      if (credential === undefined) return []
      return toModelRows(provider, catalog.current())
    },

    async resolveModel(provider, model) {
      const entry = describeModel(model)
      return {
        provider,
        id: entry.id,
        name: displayNameOf(entry),
        inputModalities: entry.supportsImages === true ? ['text', 'image'] : ['text'],
        context: { contextWindow: entry.contextWindow },
        defaultMaxTokens: entry.maxTokens,
      }
    },

    async prepareCall(provider, model) {
      return {
        model: await adapter.resolveModel(provider, model),
        stream: options => stream(options, model),
      }
    },
  }

  /**
   * What the settings card shows.
   *
   * @param options - `{ force }` re-reads the quota instead of using the cache.
   */
  async function status(options = {}) {
    const credential = await adopt()
    if (credential === undefined) {
      return { signedIn: false, provider: MIMO_PROVIDER, reason: '未在小米 MiMo 桌面端登录' }
    }
    let allowance
    try {
      allowance = await quota.read({ force: options.force === true })
    } catch (error) {
      logger.warn?.(`get-it-for-free: MiMo 额度读取失败：${error?.message ?? error}`)
    }
    if (catalog.source() !== 'gateway') {
      void refreshRoster(undefined)
    }
    return {
      signedIn: true,
      provider: MIMO_PROVIDER,
      source: credential.source === 'desktop' ? 'desktop' : 'plugin',
      models: catalog.current().map(entry => ({ id: entry.id, name: displayNameOf(entry) })),
      rosterSource: catalog.source(),
      quota: allowance ?? null,
    }
  }

  return {
    adapter,
    status,
    quota,
    dispose() {
      disposed = true
    },
  }
}

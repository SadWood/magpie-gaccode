// GACCode provider for OpenCode and magpie.
// API key authentication; optional website JWT for account details/refill requests.
// Claude uses Messages, Codex uses Responses. Gemini GenAI is endpoint-specific.
import { createAutoRefill } from "./refill.mjs"
const PROVIDER = "gaccode"
const HOST_DEFAULT = "https://gaccode.com"
const ANTHROPIC = "@ai-sdk/anthropic"
const RESPONSES = "@ai-sdk/openai"
const GOOGLE = "@ai-sdk/google"
const FELL_BACK = Symbol.for("magpie.fellBack")
// Internal evidence only: never serialized as an SDK capability or credential.
const modelRecords = new WeakMap()

function rememberModel(model, descriptor, override) {
  modelRecords.set(model, Object.freeze({
    family: descriptor.family,
    source: descriptor.source ?? "bundled-catalog",
    checkedAt: descriptor.checkedAt ?? null,
    catalogPresent: descriptor.catalogPresent ?? null,
    authentication: "unverified", // A catalog does not prove inference access.
    overrides: Object.freeze(Object.keys(override)),
    capabilities: Object.freeze({
      toolCall: Object.hasOwn(override, "tool_call") ? "user-configured" : known[descriptor.id] ? "bundled-default" : "unknown",
      reasoning: Object.hasOwn(override, "reasoning") ? "user-configured" : descriptor.reasoning !== undefined ? "bundled-default" : "unknown",
      limits: Object.freeze(Object.keys(override.limit ?? {})),
    }),
  }))
  return model
}

// Original known-model configuration defaults are preserved. They are
// configurable declarations, not endpoint capability guarantees.
const CLAUDE_MODELS = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", context: 200_000, output: 64_000, reasoning: true, images: true },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", context: 200_000, output: 64_000, reasoning: true, images: true },
  { id: "claude-fable-5", name: "Claude Fable 5", context: 200_000, output: 64_000, reasoning: true, images: true },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", context: 200_000, output: 64_000, reasoning: true, images: true },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", context: 200_000, output: 64_000, reasoning: true, images: true },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5", context: 200_000, output: 64_000, reasoning: true, images: true },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context: 200_000, output: 64_000, reasoning: true, images: true },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", context: 200_000, output: 64_000, reasoning: true, images: true },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", context: 200_000, output: 64_000, reasoning: false, images: true },
].map((m) => ({ ...m, family: "claude" }))

const CODEX_MODELS = [
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", context: 400_000, output: 128_000, reasoning: true, images: true },
  { id: "gpt-6-astra", name: "GPT-6 Astra", context: 400_000, output: 128_000, reasoning: true, images: true },
  { id: "gpt-6-sol", name: "GPT-6 Sol", context: 400_000, output: 128_000, reasoning: true, images: true },
  { id: "gpt-6-luna", name: "GPT-6 Luna", context: 400_000, output: 128_000, reasoning: true, images: true },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", context: 400_000, output: 128_000, reasoning: true, images: true },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", context: 400_000, output: 128_000, reasoning: true, images: true },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", context: 400_000, output: 128_000, reasoning: true, images: true },
  { id: "gpt-5.5", name: "GPT-5.5", context: 400_000, output: 128_000, reasoning: true, images: true },
].map((m) => ({ ...m, family: "codex" }))

// Preserve the original Gemini entries; direct GenAI compatibility remains
// endpoint-specific.
const GEMINI_MODELS = [
  { id: "gemini-3-pro-high", name: "Gemini 3 Pro High", context: 1_000_000, output: 65_536, reasoning: true, images: true },
  { id: "gemini-3-pro-low", name: "Gemini 3 Pro Low", context: 1_000_000, output: 65_536, reasoning: true, images: true },
  { id: "gemini-3-flash", name: "Gemini 3 Flash", context: 1_000_000, output: 65_536, reasoning: true, images: true },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", context: 1_000_000, output: 65_536, reasoning: true, images: true },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", context: 1_000_000, output: 65_536, reasoning: true, images: true },
].map((m) => ({ ...m, family: "gemini" }))

const known = Object.fromEntries(
  [...CLAUDE_MODELS, ...CODEX_MODELS, ...GEMINI_MODELS].map((m) => [m.id, m]),
)

function hostOf(auth) {
  const raw = String(auth?.metadata?.host ?? HOST_DEFAULT).trim() || HOST_DEFAULT
  const url = new URL(raw)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("GACCode 接入点必须是无路径或凭证的 HTTPS 地址")
  }
  return url.origin
}

function claudeBase(host) { return `${host}/claudecode/v1` }
function codexBase(host) { return `${host}/codex/v1` }
function geminiBase(host) { return `${host}/gemini/v1beta` }

function routeFor(family, host) {
  if (family === "claude") return { npm: ANTHROPIC, api: claudeBase(host) }
  if (family === "codex") return { npm: RESPONSES, api: codexBase(host) }
  if (family === "gemini") return { npm: GOOGLE, api: geminiBase(host) }
  throw new Error("Unknown GACCode API family")
}

function prettyName(id) { return known[id]?.name ?? id }

function configModel(m, host, override = {}) {
  const route = routeFor(m.family, host)
  const variants = m.reasoning ? { low: {}, medium: {}, high: {}, ...(m.family === "codex" ? { xhigh: {} } : {}) } : {}
  return rememberModel({
    name: m.family === "gemini" ? `${m.name ?? prettyName(m.id)} (experimental)` : m.name ?? prettyName(m.id),
    reasoning: m.reasoning ?? false,
    tool_call: !!known[m.id],
    variants,
    ...(m.images ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } : {}),
    ...override,
    provider: { ...route, ...(override.provider ?? {}) },
    limit: { context: m.context ?? 0, output: m.output ?? 0, ...(override.limit ?? {}) },
  }, m, override)
}

function runtimeModel(m, host, providerID = PROVIDER, override = {}) {
  const cfg = configModel(m, host, override)
  const modalities = cfg.modalities
  const input = modalities?.input
    ? Object.fromEntries(["text", "image", "audio", "video", "pdf"].map((k) => [k, modalities.input.includes(k)]))
    : { text: true }
  const output = modalities?.output
    ? Object.fromEntries(["text", "image", "audio", "video", "pdf"].map((k) => [k, modalities.output.includes(k)]))
    : { text: true }
  return rememberModel({
    id: m.id,
    providerID,
    name: cfg.name,
    api: { id: cfg.id ?? m.id, url: cfg.provider.api, npm: cfg.provider.npm },
    status: "active",
    headers: { ...(cfg.headers ?? {}) },
    options: { ...(cfg.options ?? {}) },
    cost: {
      input: cfg.cost?.input ?? 0,
      output: cfg.cost?.output ?? 0,
      cache: { read: cfg.cost?.cache_read ?? 0, write: cfg.cost?.cache_write ?? 0 },
    },
    limit: cfg.limit,
    capabilities: {
      temperature: true,
      reasoning: cfg.reasoning,
      toolcall: cfg.tool_call,
      ...(cfg.attachment !== undefined ? { attachment: cfg.attachment } : {}),
      input,
      output,
      interleaved: false,
    },
    release_date: "",
    variants: cfg.variants,
    ...(cfg.free !== undefined ? { free: cfg.free } : {}),
    ...(cfg.rate !== undefined ? { rate: cfg.rate } : {}),
    ...(cfg.rateWas !== undefined ? { rateWas: cfg.rateWas } : {}),
  }, m, override)
}

async function listOpenAIModels(url, headers) {
  const res = await fetch(url, {
    headers: { accept: "application/json", ...(headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`GACCode model catalog: HTTP ${res.status}`)
  const body = await res.json()
  if (!Array.isArray(body?.data)) throw new Error("GACCode model catalog is not a model list")
  return body.data.map((r) => r?.id).filter((id) => typeof id === "string" && id.trim())
}

async function listGeminiModels(url, headers) {
  const res = await fetch(url, {
    headers: { accept: "application/json", ...(headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`GACCode Gemini catalog: HTTP ${res.status}`)
  const body = await res.json()
  const rows = Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : null
  if (!rows) throw new Error("GACCode Gemini catalog is not a model list")
  return rows.map((r) => {
    const raw = r?.name ?? r?.id
    return typeof raw === "string" ? raw.replace(/^models\//, "") : ""
  })
    .filter((id) => typeof id === "string" && id && !id.includes("/"))
}

async function liveModels(host, apiKey, experimentalGemini = false) {
  const families = ["claude", "codex", ...(experimentalGemini ? ["gemini"] : [])]
  const settled = await Promise.allSettled(families.map((family) =>
    family === "gemini"
      ? apiKey ? listGeminiModels(`${geminiBase(host)}/models`, { "x-goog-api-key": apiKey }) : Promise.reject(new Error("Gemini catalog needs an API key"))
      : listOpenAIModels(`${routeFor(family, host).api}/models`),
  ))
  const failed = settled.findIndex((r, n) => r.status === "rejected" && families[n] !== "gemini")
  if (failed !== -1) throw new Error(`${families[failed]} catalog unavailable: ${settled[failed].reason.message}`)
  const checkedAt = new Date().toISOString()
  const list = settled.flatMap((r, n) => r.status === "rejected"
    ? GEMINI_MODELS.map((m) => ({ ...m, source: "bundled-catalog", checkedAt: null, catalogPresent: null }))
    : [...new Set(r.value)].map((id) => ({
      ...known[id], id, family: families[n], name: prettyName(id), checkedAt, catalogPresent: true,
      source: `${routeFor(families[n], host).api}/models`,
    })))
  if (new Set(list.map((m) => m.id)).size !== list.length) {
    throw new Error("Ambiguous model ID shared by GACCode protocol catalogs")
  }
  return list
}

function loginTokenOf(auth) {
  const t = auth?.metadata?.loginToken || auth?.metadata?.token
  return typeof t === "string" && t.trim() ? t.trim() : ""
}

/** 从 JWT payload 取邮箱（不校验签名，只用于展示）。 */
function emailFromJwt(token) {
  if (!token || typeof token !== "string") return ""
  try {
    const part = token.split(".")[1]
    if (!part) return ""
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/")
    const pad = "=".repeat((4 - (b64.length % 4)) % 4)
    const json = Buffer.from(b64 + pad, "base64").toString("utf8")
    const payload = JSON.parse(json)
    const e = payload?.email || payload?.user_email || payload?.preferred_username
    return typeof e === "string" && e.includes("@") ? e.trim() : ""
  } catch {
    return ""
  }
}

function emailFromMe(me) {
  const e = me?.user?.email || me?.email || me?.data?.user?.email || me?.data?.email
  return typeof e === "string" && e.includes("@") ? e.trim() : ""
}

/** Website account label only; it does not establish API-key ownership. */
function accountEmail(auth, me) {
  return (
    emailFromMe(me) ||
    emailFromJwt(loginTokenOf(auth)) ||
    (typeof auth?.metadata?.email === "string" && auth.metadata.email.includes("@")
      ? auth.metadata.email.trim()
      : "") ||
    (typeof auth?.accountId === "string" && auth.accountId.includes("@") ? auth.accountId.trim() : "") ||
    ""
  )
}

async function readJson(url, headers, signal = AbortSignal.timeout(12_000)) {
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json", ...headers },
    signal,
  })
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status}`)
    error.status = res.status
    throw error
  }
  return res.json()
}

async function siteFetch(host, path, token, signal) {
  return readJson(`${host}/api${path}`, {
    authorization: `Bearer ${token}`,
    "accept-language": "zh",
  }, signal)
}

async function statusFetch(auth) {
  return readJson(`${claudeBase(hostOf(auth))}/cc-status-line`, { "x-api-key": auth.key })
}

const REFILL_TITLES = new Set(["请求重置积分", "Request Credit Refill", "クレジット補充をお願いします"])
// Public website workflow states, not payment/credit-settlement outcomes.
const TICKET_STATES = new Map([
  ["WAITING_FOR_SUPPORT", "等待客服"],
  ["WAITING_FOR_USER", "等待用户回复"],
  ["CLOSED", "已关闭"],
])

function beijingDateStr(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d)
  const part = (type) => parts.find((p) => p.type === type)?.value
  return `${part("year")}-${part("month")}-${part("day")}`
}

function isRefillTicket(ticket) {
  return ticket?.category?.key === "REQUEST_TO_REFILL_CREDIT" ||
    REFILL_TITLES.has(String(ticket?.title ?? ""))
}

function ticketOnBeijingDay(ticket, day) {
  const raw = ticket?.createdAt ?? ticket?.created_at
  if (!raw) return false
  const date = new Date(raw)
  return Number.isFinite(date.getTime()) && beijingDateStr(date) === day
}

async function ticketRefillReceipt(host, token, ticket) {
  const ticketId = String(ticket.id ?? "")
  if (!/^[1-9]\d*$/.test(ticketId) || !Number.isSafeInteger(Number(ticketId))) return { receipt: null }
  const createdAt = ticket.createdAt ?? ticket.created_at
  const start = typeof createdAt === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(createdAt) ? Date.parse(createdAt) : NaN
  const end = Date.now()
  if (!Number.isFinite(start) || start > end) throw new Error("工单时间格式未知")
  const signal = AbortSignal.timeout(6_000)
  const limit = 100
  let total
  for (let page = 1; page <= 5; page++) {
    const query = new URLSearchParams({ page: String(page), limit: String(limit), startTime: createdAt, endTime: new Date(end).toISOString() })
    const body = await siteFetch(host, `/credits/history?${query}`, token, signal)
    const rows = body?.history
    const pages = body?.totalPages
    if (!Array.isArray(rows) || body.currentPage !== page || body.limit !== limit ||
        !Number.isSafeInteger(body.total) || body.total < 0 || !Number.isSafeInteger(pages) || pages < 0 ||
        !(pages === Math.ceil(body.total / limit) || (body.total === 0 && pages === 1)) ||
        (total !== undefined && total !== body.total) ||
        rows.length !== Math.min(limit, Math.max(0, body.total - (page - 1) * limit))) {
      throw new Error("积分流水分页格式未知")
    }
    total = body.total
    for (const row of rows) {
      const reference = typeof row?.details === "string" ? row.details.match(/^Automatic refill via support ticket #([1-9]\d*)$/) : null
      const at = typeof row?.createdAt === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(row.createdAt) ? Date.parse(row.createdAt) : NaN
      if (row?.reason !== "refill" || typeof row.amount !== "number" || !Number.isFinite(row.amount) || row.amount <= 0 ||
          typeof row.balanceAfter !== "number" || !Number.isFinite(row.balanceAfter) || reference?.[1] !== ticketId ||
          !Number.isFinite(at) || at < start || at > end ||
          (ticket.userId !== undefined && row.userId !== undefined && String(ticket.userId) !== String(row.userId))) continue
      return { receipt: { ticketId, amount: row.amount, balanceAfter: row.balanceAfter, createdAt: row.createdAt } }
    }
    if (page >= pages) return { receipt: null }
  }
  return { receipt: null, receiptIncomplete: true }
}

async function todayRefillStatus(host, token) {
  const day = beijingDateStr()
  try {
    const body = await siteFetch(host, "/tickets?page=1&limit=20", token)
    const tickets = Array.isArray(body?.tickets) ? body.tickets : Array.isArray(body?.data) ? body.data : null
    if (!tickets) throw new Error("工单列表格式未知")
    const ticket = tickets.find((t) => isRefillTicket(t) && ticketOnBeijingDay(t, day))
    const result = { day, already: !!ticket, ticket: ticket ?? null }
    if (ticket) {
      try { Object.assign(result, await ticketRefillReceipt(host, token, ticket)) }
      catch { result.receiptError = "积分流水读取失败" }
    }
    return result
  } catch (e) {
    return { day, already: false, ticket: null, error: e.status === 401 ? "网站登录已过期" : e.message }
  }
}

function finiteNumber(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function extractUsd(body) {
  if (body?.account === null) return { status: "no_account", display: "未开通" }
  const account = body?.account
  const value = finiteNumber(account?.balanceUsd)
  if (value === null) return { status: "no_field", display: "余额未知" }
  return {
    status: "ok", value, enabled: account.enabled,
    display: `$${value}${account.enabled === false ? "（已停用）" : ""}`,
  }
}

function boosterRows(body) {
  if (Array.isArray(body?.boosterPacks)) return body.boosterPacks
  if (Array.isArray(body?.boosters)) return body.boosters
  if (Array.isArray(body?.data)) return body.data
  if (Array.isArray(body?.items)) return body.items
  if (Array.isArray(body)) return body
  return null
}

function boosterState(pack) {
  const rawExpiry = pack?.expiresAt ?? pack?.expires_at
  const expiry = rawExpiry ? new Date(rawExpiry).getTime() : NaN
  const used = pack?.isUsed === true || pack?.used === true
  return used ? "已用" : Number.isFinite(expiry)
    ? (expiry <= Date.now() ? "已过期" : "可用")
    : "未使用 · 有效期未知"
}

function formatBoosterLine(pack) {
  const name = pack?.comment || pack?.name || (pack?.id != null ? `补充包 #${pack.id}` : "补充包")
  const credits = finiteNumber(pack?.credits)
  const status = boosterState(pack)
  return [name, credits !== null ? `${credits} 积分` : "积分未知", status].join(" · ")
}

function summarizeBoosters(body, fetchError) {
  if (fetchError) return { status: "error", display: `读取失败（${fetchError}）` }
  const rows = boosterRows(body)
  if (rows === null) return { status: "missing", display: "列表未知" }
  if (!rows.length) return { status: "empty", display: "无加油包" }
  const counts = new Map()
  for (const pack of rows) {
    const state = boosterState(pack)
    counts.set(state, (counts.get(state) ?? 0) + 1)
  }
  return {
    status: "ok", count: rows.length,
    compact: ["可用", "已过期", "已用", "未使用 · 有效期未知"]
      .filter((state) => counts.has(state))
      .map((state) => `${state === "未使用 · 有效期未知" ? "有效期未知" : state} ${counts.get(state)}`)
      .join(" / "),
    display: rows.slice(0, 5).map(formatBoosterLine).join("；") +
      (rows.length > 5 ? `；另有 ${rows.length - 5} 个` : ""),
  }
}

function sourceError(result) {
  const e = result.reason
  return e?.status === 401 ? "网站凭证未获授权" : e?.message ?? "读取失败"
}

async function buildUsage(auth, refill) {
  const token = loginTokenOf(auth)
  // Website credentials stay on the website; choosing an inference relay
  // does not authorize sending a website session to that relay.
  const settled = await Promise.allSettled([
    token ? siteFetch(HOST_DEFAULT, "/credits/balance", token) : statusFetch(auth),
    ...(token ? [
      siteFetch(HOST_DEFAULT, "/subscriptions", token),
      siteFetch(HOST_DEFAULT, "/me", token),
      siteFetch(HOST_DEFAULT, "/usd-account", token),
      siteFetch(HOST_DEFAULT, "/credits/booster-packs", token),
      todayRefillStatus(HOST_DEFAULT, token),
      statusFetch(auth),
    ] : []),
  ])
  const out = { plan: "GACCode", windows: [], signIn: "kept" }
  const balanceLines = []
  const summary = []
  const notes = []
  let money = ""
  let appliedToday = false
  let resetToday = false
  const status = settled[0]
  const keyStatus = token ? settled[6] : status
  const keyAccount = keyStatus?.status === "fulfilled" ? emailFromMe(keyStatus.value) : ""
  const websiteAccount = token && settled[2]?.status === "fulfilled" ? emailFromMe(settled[2].value) : ""
  const account = token ? websiteAccount : keyAccount
  if (account) out.user = account
  const sameAccount = !!websiteAccount && websiteAccount.toLowerCase() === keyAccount.toLowerCase()
  if (status.status === "fulfilled") {
    const balance = finiteNumber(status.value?.balance)
    const cap = finiteNumber(status.value?.creditCap)
    const mult = finiteNumber(status.value?.timeMultiplier?.value ??
      (sameAccount ? keyStatus.value?.timeMultiplier?.value : undefined))
    if (balance === null) {
      out.error = `${token ? "网站积分" : "积分状态"}未提供有效余额`
    } else {
      const count = cap !== null && cap > 0 ? `${balance} / ${cap}` : `${balance} 积分`
      const refillRate = finiteNumber(status.value?.refillRate ?? status.value?.creditsPerHour)
      if (refillRate !== null) summary.push(`${refillRate}/时`)
      // 1x is the normal rate; a missing multiplier is left out, never guessed.
      if (mult !== null && mult > 0 && mult !== 1) summary.push(`时段 ${mult}x`)
      if (cap !== null && cap > 0) {
        out.windows.push({
          name: "积分", used: Math.max(0, 100 * (cap - balance) / cap),
          display: count, aside: true,
        })
      } else {
        balanceLines.push(count)
      }
    }
  } else {
    out.error = `${token ? "网站积分" : "积分状态"}读取失败（${status.reason?.message ?? "未知错误"}）`
  }

  if (token) {
    const [, subscription, me, usdResult, packs, refillResult] = settled
    // Credits and subscription are both website data under this JWT. Their
    // identity and plan do not depend on the optional API-key statusline.
    const details = []
    if (websiteAccount && keyAccount && !sameAccount) details.push(`API key 账户 ${keyAccount}`)
    if (subscription.status === "fulfilled") {
      const subscriptions = subscription.value?.subscriptions
      const first = Array.isArray(subscriptions) ? subscriptions[0] : null
      const plan = first?.planName ?? first?.plan ?? first?.subscription?.name ?? first?.subscription?.tier ?? first?.name ?? first?.productName
      if (typeof plan === "string") out.plan = plan
      else if (Array.isArray(subscriptions) && !subscriptions.length) details.push("无订阅")
      if (typeof first?.endDate === "string") out.until = first.endDate
      if (typeof first?.autoRenew === "boolean") out.renew = first.autoRenew ? "auto" : "off"
    } else {
      details.push(`套餐读取失败（${sourceError(subscription)}）`)
    }
    if (me.status === "rejected") details.push(`网站账户读取失败（${sourceError(me)}）`)
    const usd = usdResult.status === "fulfilled" ? extractUsd(usdResult.value) : null
    if (!usd) notes.push(`USD 读取失败（${sourceError(usdResult)}）`)
    else if (usd.status === "ok") money = usd.display
    else if (usd.status !== "no_account") notes.push(`USD ${usd.display}`)
    const boost = packs.status === "fulfilled"
      ? summarizeBoosters(packs.value)
      : summarizeBoosters(null, sourceError(packs))
    if (boost.status !== "empty") notes.push(`加油包 ${boost.compact ?? boost.display}`)
    const refill = refillResult.status === "fulfilled" ? refillResult.value : { error: sourceError(refillResult) }
    // A found ticket shows an application, not credits arriving; none found proves nothing.
    if (refill.error) notes.push(`工单读取失败（${refill.error}）`)
    else if (refill.already) {
      appliedToday = true
      resetToday = !!refill.receipt
      notes.push(refill.receipt ? `今日已重置（+${refill.receipt.amount} 积分）`
        : `今日已申请（工单${TICKET_STATES.get(refill.ticket?.status) ?? "状态未知"}）`)
      if (refill.receiptError) notes.push(refill.receiptError)
      else if (refill.receiptIncomplete) notes.push("积分流水未查全")
    }
    notes.push(...details)
  }
  // With no windows, magpie renders balance before error. Never let website
  // details hide a failed credit query behind a large balance figure.
  const autoNote = refill ? await refill.text(auth, settled[2]) : ""
  if (out.error) {
    if (autoNote && !["自动申请：选项关闭", "自动申请：待触发"].includes(autoNote)) out.error += `；${autoNote}`
    return out
  }
  // magpie shows only the first two " · " parts of a window's display;
  // its title retains the whole string, so details follow the short summary.
  if (autoNote && autoNote !== "自动申请：选项关闭" &&
      !(appliedToday && ["自动申请：待触发", "自动申请：已申请", "自动申请：已有同日申请或待处理工单"].includes(autoNote))) notes.push(autoNote)
  summary.push(resetToday ? "已重置" : "未重置")
  // "未重置" means no confirmed receipt today, including unreadable evidence.
  if (!resetToday && !appliedToday) notes.unshift(token ? "今日尚未确认重置" : "今日重置未核验（需网站 JWT）")
  const credit = out.windows[0]
  if (credit) {
    credit.display += " · " + summary.join("，")
    if (notes.length) credit.display += " · " + notes.join("，")
    if (money) out.balance = money
  } else {
    const lines = [...balanceLines, money, ...summary, ...notes].filter(Boolean)
    if (lines.length) out.balance = lines.join(" · ")
  }
  return out
}

function managedFamily(url) {
  if (url.hostname !== "gaccode.com" && !/^relay\d{2}\.gaccode\.com$/.test(url.hostname)) return null
  if (/^\/claudecode\/v1(?:\/|$)/.test(url.pathname)) return "claude"
  if (/^\/codex\/v1(?:\/|$)/.test(url.pathname)) return "codex"
  if (/^\/gemini\/v1beta(?:\/|$)/.test(url.pathname)) return "gemini"
  return null
}

function matchesEndpoint(url, endpoint) {
  try {
    const custom = new URL(endpoint)
    const path = custom.pathname.replace(/\/$/, "")
    return custom.origin === url.origin && (url.pathname === path || url.pathname.startsWith(path + "/"))
  } catch { return false }
}

async function providerFetch(input, init, auth, customEndpoints = []) {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const family = managedFamily(url)
  const custom = customEndpoints.some((endpoint) => matchesEndpoint(url, endpoint))
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
  let target = input
  if (family && !custom) {
    const host = new URL(hostOf(auth))
    url.protocol = host.protocol
    url.host = host.host
    // Keep the SDK's family-specific path/query; a single baseURL would lose them.
    if (input instanceof Request) target = new Request(url, input)
    else target = input instanceof URL ? url : url.href
    if (family === "claude") headers.set("x-api-key", auth.key)
    else if (family === "codex") headers.set("authorization", `Bearer ${auth.key}`)
    else headers.set("x-goog-api-key", auth.key)
  }
  // Preserve successful streams and upstream error bodies/headers unchanged.
  return fetch(target, { ...init, headers })
}

const hostPrompt = {
  type: "select", key: "host", message: "GACCode 推理接入点",
  options: [
    { label: "官方 (gaccode.com)", value: HOST_DEFAULT },
    { label: "relay05", value: "https://relay05.gaccode.com", hint: "可选中继，各 API 的可用性需单独验证" },
  ],
}

export const _internal = {
  PROVIDER, HOST_DEFAULT, CLAUDE_MODELS, CODEX_MODELS, GEMINI_MODELS,
  hostOf, claudeBase, codexBase, geminiBase, liveModels, prettyName,
  configModel, runtimeModel, buildUsage, listGeminiModels,
  todayRefillStatus, ticketRefillReceipt, extractUsd, summarizeBoosters, formatBoosterLine,
  statusFetch, providerFetch,
  modelEvidence: (model) => modelRecords.get(model),
}

export async function GacCodePlugin({ client, directory } = {}, options = {}) {
  const experimentalGemini = options?.experimentalGemini !== false
  const autoRequestRefill = (auth) => Object.hasOwn(options ?? {}, "autoRequestRefill") && options.autoRequestRefill !== undefined
    ? options.autoRequestRefill === true
    : !["off", "false", "0"].includes(String(auth?.metadata?.autoDailyReset ?? "on").toLowerCase())
  const refill = createAutoRefill({ enabled: autoRequestRefill, directory })
  const defaults = [...CLAUDE_MODELS, ...CODEX_MODELS, ...(experimentalGemini ? GEMINI_MODELS : [])]
  let overrides = {}
  let customEndpoints = []
  let customRefillEndpoints = []
  let customProvider = false
  let providerDefaults = { npm: ANTHROPIC, api: claudeBase(HOST_DEFAULT) }

  function descriptorFor(id) {
    if (known[id]) return known[id]
    const npm = overrides[id]?.provider?.npm ?? providerDefaults.npm
    return { id, name: id, family: npm === RESPONSES ? "codex" : npm === GOOGLE ? "gemini" : "claude" }
  }

  function enabled(m) {
    return !overrides[m.id]?.disabled && (m.family !== "gemini" || experimentalGemini ||
      typeof overrides[m.id]?.provider?.api === "string")
  }

  function modelMap(list, host, providerID, live = false) {
    const descriptors = new Map(list.map((m) => [m.id, m]))
    for (const id of Object.keys(overrides)) {
      if (!descriptors.has(id)) descriptors.set(id, {
        ...descriptorFor(id), source: "user-config", catalogPresent: live ? false : null,
      })
    }
    return Object.fromEntries([...descriptors.values()]
      .filter(enabled)
      .map((m) => [m.id, runtimeModel(m, host, providerID, overrides[m.id])]))
  }

  return {
    async config(cfg) {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      overrides = { ...(was.models ?? {}) }
      providerDefaults = { ...providerDefaults, npm: was.npm ?? ANTHROPIC, api: was.api ?? claudeBase(HOST_DEFAULT) }
      customEndpoints = Object.values(overrides).map((m) => m.provider?.api).filter((api) => typeof api === "string")
      customProvider = typeof was.api === "string" || typeof was.options?.baseURL === "string"
      customRefillEndpoints = [...customEndpoints, ...Object.values(overrides).map((m) => m.options?.baseURL).filter((api) => typeof api === "string")]
      const models = Object.fromEntries(defaults.filter(enabled).map((m) => [m.id, configModel(m, HOST_DEFAULT, overrides[m.id])]))
      for (const [id, override] of Object.entries(overrides)) {
        const descriptor = descriptorFor(id)
        if (!models[id] && enabled(descriptor)) models[id] = configModel(descriptor, HOST_DEFAULT, override)
      }
      cfg.provider[PROVIDER] = {
        name: "GACCode", npm: ANTHROPIC, api: claudeBase(HOST_DEFAULT),
        ...was, models,
      }
    },

    auth: {
      provider: PROVIDER,
      methods: [{
        type: "api",
        label: "GACCode API key",
        placeholder: "从 gaccode.com/api-keys 复制",
        prompts: [
          hostPrompt,
          {
            type: "text", key: "loginToken",
            message: "网站 JWT（按原版方式读取网站积分和套餐；自动申请也使用此凭证）",
            placeholder: "浏览器登录后复制 localStorage.token；留空仅尝试 API key 基础查询",
          },
        ],
      }],
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        return {
          apiKey: auth.key,
          async fetch(input, init = {}) {
            const current = await getAuth()
            if (current?.type !== "api" || !current.key) throw new Error("GACCode API key 未配置")
            const url = new URL(input instanceof Request ? input.url : String(input))
            if (!experimentalGemini && managedFamily(url) === "gemini" &&
                !customEndpoints.some((endpoint) => matchesEndpoint(url, endpoint))) {
              throw new Error("实验性 Gemini 未启用，请设置 experimentalGemini")
            }
            const response = await providerFetch(input, init, current, customEndpoints)
            if (autoRequestRefill(current)) {
              try {
                const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
                const host = new URL(hostOf(current))
                const trusted = (u) => u.protocol === "https:" && !u.port && !u.username && !u.password &&
                  (u.hostname === "gaccode.com" || /^relay\d{2}\.gaccode\.com$/.test(u.hostname))
                const inference = /^\/(?:claudecode\/v1\/messages|codex\/v1\/responses|gemini\/v1beta\/models\/[^/]+:(?:streamGenerateContent|generateContent))$/.test(url.pathname)
                if (method === "POST" && inference && trusted(url) && trusted(host) && !response.redirected && !customProvider &&
                    !customRefillEndpoints.some((endpoint) => matchesEndpoint(url, endpoint))) {
                  await refill.observe(current, response, `${claudeBase(host.origin)}/cc-status-line`)
                }
              } catch {} // Optional side effects cannot replace the original inference error.
            }
            return response
          },
        }
      },
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return { error: "未登录", windows: [], signIn: "kept" }
        try { return await buildUsage(auth, refill) }
        catch (e) { return { error: e.message, windows: [], signIn: "kept" } }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const key = auth?.type === "api" ? auth.key : undefined
        const host = hostOf(auth)
        try {
          const list = await liveModels(host, key, experimentalGemini)
          return modelMap(list, host, provider.id ?? PROVIDER, true)
        } catch (e) {
          try {
            await client?.app?.log?.({ body: {
              service: "gaccode", level: "warn",
              message: `Model catalog unavailable; using the whole fallback snapshot: ${e.message}`,
            } })
          } catch {}
          const fallback = modelMap(defaults, host, provider.id ?? PROVIDER)
          fallback[FELL_BACK] = true
          return fallback
        }
      },
    },
  }
}

export default {
  id: "gaccode-auth",
  server: GacCodePlugin,
}
